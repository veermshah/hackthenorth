"""Self-hosted visual localization (hloc + COLMAP), an additive alternative to
Niantic VPS. Run with modal run -m services.backend.deployment.modal_localization
--help for the mapping CLI. See app/api/worlds.py's
POST /worlds/{id}/localize/self-hosted for the consumer side.

Stage 1 (build_map): offline, once per world/revision. Extracts frames from a
walkthrough video, runs hloc's standard SfM pipeline (SuperPoint local features,
NetVLAD global descriptors, LightGlue matching, COLMAP incremental mapping), and
persists the resulting map to the htn-localization-maps volume.

Stage 2 (Localizer.localize): online, one query image in -> one pose out. Loads a
world's map once per warm container, then per query: extracts query features,
retrieves the most similar mapped images, matches against their known 3D points,
and runs PnP+RANSAC (pycolmap) to recover a 6DoF pose.

No automatic alignment between this map's coordinate frame and the splat/world
frame -- like Niantic's `alignment`, that is a manual one-time transform an
operator computes and pastes into the world manifest (see world.schema.json).
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[3]
image = (
    modal.Image.debian_slim(python_version='3.12')
    .apt_install('git', 'ffmpeg', 'libgl1', 'libglib2.0-0')
    .pip_install_from_requirements(str(ROOT / 'services/backend/deployment/localization-requirements.txt'))
    # hloc vendors SuperPoint/SuperGlue as git submodules under third_party/, but
    # its own wheel build does not package that directory (it lives outside the
    # `hloc` package tree) -- pip only gets the `hloc` package itself either way.
    # Clone recursively, install the package, and put third_party/ on PYTHONPATH
    # so `from SuperGluePretrainedNetwork...` (hloc/extractors/superpoint.py)
    # resolves as an implicit namespace package.
    .run_commands(
        'git clone --recursive https://github.com/cvg/Hierarchical-Localization.git /opt/hloc',
        'pip install /opt/hloc',
    )
    .env({'PYTHONPATH': '/opt/hloc/third_party'})
    .workdir('/root')
)

app = modal.App('htn-visual-localization')
volume = modal.Volume.from_name('htn-localization-maps', create_if_missing=True)

# Separate image for Gaussian Splat training: gsplat's rasterizer is a custom CUDA
# extension that needs an actual nvcc toolchain to compile, not just torch's bundled
# runtime CUDA libraries -- a plain debian_slim image (used above) is insufficient.
# A CUDA "devel" base image ships a coherent, pre-matched nvcc+headers+ptxas set;
# piecing one together from separately-versioned nvidia-cuda-nvcc/-cccl pip packages
# was tried and hit real version-skew failures (mismatched PTX ISA versions).
NERFVIEW_COMMIT = '4538024fe0d15fd1a0e4d760f3695fc44ca72787'  # pinned by gsplat's own examples/requirements.txt
splat_image = (
    modal.Image.from_registry('nvidia/cuda:12.4.1-devel-ubuntu22.04', add_python='3.12')
    .apt_install('git', 'ffmpeg', 'libgl1', 'libglib2.0-0', 'clang')
    .pip_install('torch', 'torchvision', index_url='https://download.pytorch.org/whl/cu124')
    .pip_install('packaging', 'ninja', 'wheel', 'setuptools')
    # Only the subset of gsplat/examples' requirements.txt that simple_trainer.py
    # actually imports at module level; skips other examples' extras (fused-ssim,
    # fused-bilagrid, ppisp, nvidia-ncore) that aren't needed for a basic run.
    .pip_install(
        'pycolmap', 'opencv-python-headless', 'imageio[ffmpeg]', 'scipy',
        'scikit-learn', 'tqdm', 'torchmetrics', 'tyro', 'pillow', 'piexif',
        'tensorboard', 'pyyaml', 'matplotlib', 'viser', 'splines',
    )
    .pip_install(f'nerfview @ git+https://github.com/nerfstudio-project/nerfview@{NERFVIEW_COMMIT}')
    # Install gsplat from the SAME clone as examples/simple_trainer.py, not PyPI:
    # the PyPI release (1.5.3) lags the git main branch's examples and is missing
    # modules simple_trainer.py imports (e.g. gsplat.color_correct).
    # Image builds run without a GPU attached, so torch can't auto-detect a target
    # arch for gsplat's ahead-of-time CUDA build; T4 is compute capability 7.5.
    .env({'TORCH_CUDA_ARCH_LIST': '7.5'})
    .run_commands(
        # Pin to the v1.5.3 release tag, not main: main has moved ahead to use a
        # newer CCCL API (cuda::ceil_div) than CUDA 12.4 ships, and its examples
        # already drifted from the last PyPI release (missing gsplat.color_correct).
        # v1.5.3 is also the exact version already confirmed to build/run correctly
        # on this image (Stage A spike). --recurse-submodules: gsplat vendors glm
        # (header-only C++ math lib) as a submodule; a shallow non-recursive clone
        # leaves that directory empty, breaking the CUDA build's #include.
        'git clone --depth 1 --branch v1.5.3 --recurse-submodules https://github.com/nerfstudio-project/gsplat.git /opt/gsplat',
        # --no-build-isolation: an isolated build env would fetch its own default
        # torch (currently resolving to a cu130 build), which then mismatches the
        # cu124 nvcc toolchain in this image. Reuse the already-installed cu124 torch.
        'pip install --no-build-isolation /opt/gsplat',
    )
)

# Deliberately not configurable per-request: keep the map-building and query-time
# feature choices consistent, since a query must be extracted with matching
# feature/matcher configs to compare against the map.
RETRIEVAL_CONF = 'netvlad'
FEATURE_CONF = 'superpoint_aachen'
MATCHER_CONF = 'superpoint+lightglue'
NUM_MATCHED = 20


def _extract_frames(video: Path, out_dir: Path, fps: float, limit: int):
    """Denser than the annotation pipeline's 1/3s sampling: SfM needs much more
    view overlap between consecutive frames than a single-frame-per-feature scan."""
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(video),
                     '-vf', f'fps={fps}', '-frames:v', str(limit), '-q:v', '3',
                     str(out_dir / 'frame-%05d.jpg')], check=True, timeout=1800)
    if not list(out_dir.glob('*.jpg')):
        raise ValueError('Video produced no frames')


@app.function(image=image, volumes={'/data': volume}, gpu='T4', cpu=4, memory=8192, timeout=3600)
def build_map(world_id: str, revision: str, video_bytes: bytes, fps: float = 1.5, limit: int = 300):
    from hloc import extract_features, match_features, pairs_from_exhaustive, reconstruction

    work = Path(tempfile.mkdtemp())
    try:
        video_path = work / 'walkthrough.mp4'
        video_path.write_bytes(video_bytes)
        images_dir = work / 'images'
        _extract_frames(video_path, images_dir, fps, limit)

        outputs = work / 'outputs'
        feature_conf = extract_features.confs[FEATURE_CONF]
        matcher_conf = match_features.confs[MATCHER_CONF]
        retrieval_conf = extract_features.confs[RETRIEVAL_CONF]

        feature_path = extract_features.main(feature_conf, images_dir, outputs)
        pairs_path = outputs / 'pairs.txt'
        pairs_from_exhaustive.main(pairs_path, features=feature_path)
        match_path = match_features.main(matcher_conf, pairs_path, feature_conf['output'], outputs)
        retrieval_path = extract_features.main(retrieval_conf, images_dir, outputs)

        sfm_dir = outputs / 'sfm'
        model = reconstruction.main(sfm_dir, images_dir, pairs_path, feature_path, match_path)
        if model is None or model.num_reg_images() == 0:
            raise ValueError('Reconstruction failed: not enough overlap/texture between frames. '
                              'Capture a slower, more overlapping walkthrough and retry.')

        dest = Path('/data') / world_id / revision
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        shutil.copytree(sfm_dir, dest / 'sfm')
        shutil.copy(feature_path, dest / 'features.h5')
        shutil.copy(match_path, dest / 'matches.h5')
        shutil.copy(retrieval_path, dest / 'retrieval.h5')
        shutil.copytree(images_dir, dest / 'images')
        model.export_PLY(str(dest / 'points.ply'))
        volume.commit()

        return {'imagesRegistered': model.num_reg_images(), 'totalImages': len(list(images_dir.glob('*.jpg'))),
                'points3D': model.num_points3D(), 'summary': model.summary()}
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.function(image=splat_image, volumes={'/data': volume}, gpu='T4', timeout=3600)
def train_splat(world_id: str, revision: str, max_steps: int = 7000) -> bytes:
    """Trains a Gaussian Splat from build_map's already-persisted COLMAP output
    (images/ + sfm/) using gsplat's reference training script. Photorealistic
    visualization only -- unrelated to Localizer's feature-matching localization.
    7000 steps is a fast-preview default (paper default is 30,000); pass a higher
    max_steps for better quality once a run is confirmed to work end to end."""
    import sys

    volume.reload()
    base = Path('/data') / world_id / revision
    if not (base / 'sfm').exists() or not (base / 'images').exists():
        raise ValueError(f'No self-hosted map for {world_id}/{revision}; run build_map first')

    work = Path(tempfile.mkdtemp())
    try:
        # gsplat's COLMAP dataset loader expects data_dir/{images,sparse/0}; our
        # build_map layout is {images,sfm}. Symlink rather than copy -- these can
        # be large image sets and nothing needs to write into either directory.
        dataset_dir = work / 'dataset'
        (dataset_dir / 'sparse').mkdir(parents=True)
        (dataset_dir / 'sparse' / '0').symlink_to(base / 'sfm')
        (dataset_dir / 'images').symlink_to(base / 'images')

        result_dir = work / 'result'
        subprocess.run([
            sys.executable, '/opt/gsplat/examples/simple_trainer.py', 'default',
            '--data_dir', str(dataset_dir), '--data_factor', '1',
            '--max_steps', str(max_steps), '--save_ply', '--disable_viewer',
            '--result_dir', str(result_dir),
        ], check=True, cwd='/opt/gsplat/examples', timeout=3300)

        ply_path = result_dir / 'ply' / f'point_cloud_{max_steps - 1}.ply'
        if not ply_path.exists():
            candidates = sorted((result_dir / 'ply').glob('*.ply'))
            if not candidates:
                raise ValueError('Training completed but no PLY was exported; check simple_trainer.py output')
            ply_path = candidates[-1]
        return ply_path.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.function(image=image, volumes={'/data': volume}, timeout=60)
def get_map_ply(world_id: str, revision: str) -> bytes:
    volume.reload()
    path = Path('/data') / world_id / revision / 'points.ply'
    if not path.exists():
        raise ValueError(f'No self-hosted map for {world_id}/{revision}; run build_map first')
    return path.read_bytes()


@app.function(image=image, volumes={'/data': volume}, timeout=60)
def get_map_cameras(world_id: str, revision: str):
    """Registered camera positions/orientations, so a viewer can render frustums
    alongside the point cloud, not just the raw points."""
    import pycolmap

    volume.reload()
    base = Path('/data') / world_id / revision
    if not (base / 'sfm').exists():
        raise ValueError(f'No self-hosted map for {world_id}/{revision}; run build_map first')
    reconstruction = pycolmap.Reconstruction(str(base / 'sfm'))
    cameras = []
    for image_id, image in reconstruction.images.items():
        world_from_cam = image.cam_from_world().inverse()
        cameras.append({'id': image_id, 'name': image.name,
                        'position': world_from_cam.translation.tolist(),
                        'rotation': world_from_cam.rotation.quat.tolist()})
    return cameras


@app.cls(image=image, volumes={'/data': volume}, gpu='T4', min_containers=1, max_containers=4, timeout=300)
class Localizer:
    @modal.enter()
    def _init(self):
        self._maps = {}

    def _load(self, world_id: str, revision: str):
        key = (world_id, revision)
        if key not in self._maps:
            import pycolmap
            # A warm container's volume mount can be stale relative to a map
            # committed by a separate build_map invocation; pick up new commits.
            volume.reload()
            base = Path('/data') / world_id / revision
            if not (base / 'sfm').exists():
                raise ValueError(f'No self-hosted map for {world_id}/{revision}; run build_map first')
            reconstruction = pycolmap.Reconstruction(str(base / 'sfm'))
            self._maps[key] = {
                'reconstruction': reconstruction,
                'db_name_to_id': {img.name: image_id for image_id, img in reconstruction.images.items()},
                'features_path': base / 'features.h5',
                'retrieval_path': base / 'retrieval.h5',
            }
        return self._maps[key]

    @modal.method()
    def localize(self, world_id: str, revision: str, image_bytes: bytes, width: int, height: int):
        import numpy as np
        import pycolmap
        from hloc import extract_features, match_features, pairs_from_retrieval
        from hloc.localize_sfm import QueryLocalizer, pose_from_cluster

        ctx = self._load(world_id, revision)
        work = Path(tempfile.mkdtemp())
        try:
            query_dir = work / 'query'
            query_dir.mkdir(parents=True)
            (query_dir / 'query.jpg').write_bytes(image_bytes)
            outputs = work / 'out'

            retrieval_conf = extract_features.confs[RETRIEVAL_CONF]
            feature_conf = extract_features.confs[FEATURE_CONF]
            matcher_conf = match_features.confs[MATCHER_CONF]

            q_retrieval = extract_features.main(retrieval_conf, query_dir, outputs, image_list=['query.jpg'])
            q_features = extract_features.main(feature_conf, query_dir, outputs, image_list=['query.jpg'])

            pairs_path = outputs / 'pairs.txt'
            num_matched = min(NUM_MATCHED, len(ctx['db_name_to_id']))
            pairs_from_retrieval.main(q_retrieval, pairs_path, num_matched=num_matched,
                                       db_descriptors=ctx['retrieval_path'])
            match_path = match_features.main(matcher_conf, pairs_path, feature_conf['output'], outputs,
                                              features_ref=ctx['features_path'])

            with open(pairs_path, encoding='utf-8') as handle:
                db_names = sorted({line.split()[1] for line in handle if line.strip()})
            db_ids = [ctx['db_name_to_id'][name] for name in db_names if name in ctx['db_name_to_id']]
            if not db_ids:
                return {'trackingState': 'lost', 'confidence': 0.0}

            # No real calibration is available from a browser/webcam test client;
            # this is a rough focal-length guess, not a measured intrinsic. The
            # iOS/ARKit path has real intrinsics and should pass those instead.
            focal_guess = 1.2 * max(width, height)
            camera = pycolmap.Camera(model='SIMPLE_PINHOLE', width=width, height=height,
                                      params=np.array([focal_guess, width / 2, height / 2]))

            localizer = QueryLocalizer(ctx['reconstruction'], {})
            ret, _log = pose_from_cluster(localizer, 'query.jpg', camera, db_ids, q_features, match_path)
            if ret is None:
                return {'trackingState': 'lost', 'confidence': 0.0}

            world_from_cam = ret['cam_from_world'].inverse()
            inliers = int(ret['num_inliers'])
            tracking_state = 'localized' if inliers >= 12 else 'limited' if inliers >= 4 else 'lost'
            return {
                'position': world_from_cam.translation.tolist(),
                'rotation': world_from_cam.rotation.quat.tolist(),  # [x, y, z, w]
                'confidence': min(1.0, inliers / 30.0),
                'trackingState': tracking_state,
                'numInliers': inliers,
            }
        finally:
            shutil.rmtree(work, ignore_errors=True)


@app.local_entrypoint()
def main(video: str, world: str, revision: str = 'v1', fps: float = 1.5, limit: int = 300):
    source = Path(video)
    if not source.is_file():
        raise ValueError('Video file does not exist')
    result = build_map.remote(world, revision, source.read_bytes(), fps, limit)
    print(result)
