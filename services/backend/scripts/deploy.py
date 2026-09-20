"""Run from the repo root: python -m services.backend.scripts.deploy."""
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

from dotenv import dotenv_values, set_key

ROOT = Path(__file__).resolve().parents[3]


def run(*args, capture=False):
    result = subprocess.run([sys.executable, '-X', 'utf8', '-m', 'modal', *args], cwd=ROOT,
                            text=True, encoding='utf-8', stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None)
    if capture:
        print(result.stdout)
    result.check_returncode()
    return result.stdout or ''


def main():
    env_file = ROOT / 'services/backend/.env'
    if not env_file.exists():
        raise SystemExit('Create services/backend/.env with your OpenAI and Elasticsearch settings first.')
    values = dotenv_values(env_file)
    if not values.get('WANDER_API_KEY'):
        set_key(str(env_file), 'WANDER_API_KEY', secrets.token_urlsafe(48))
        print('Generated WANDER_API_KEY and saved it in services/backend/.env.')
        values = dotenv_values(env_file)
    # Verify authentication before changing remote configuration.
    run('secret', 'list')
    # Local filesystem overrides must never replace the deployment's Linux defaults.
    excluded = {'GRAPH_PATH', 'WANDER_DATA_ROOT', 'WANDER_BACKEND_URL'}
    with tempfile.TemporaryDirectory(prefix='wander-deploy-') as directory:
        remote_env = Path(directory) / '.env'
        remote_env.touch(mode=0o600)
        for key, value in values.items():
            if key not in excluded and value is not None:
                set_key(str(remote_env), key, value)
        run('secret', 'create', 'htn-backend', '--from-dotenv', str(remote_env), '--force')
    output = run('deploy', '-m', 'services.backend.deployment.modal_app', capture=True)
    clean = re.sub(r'\x1b\[[0-9;]*m', '', output)
    urls = list(dict.fromkeys(re.findall(r'https://[A-Za-z0-9.-]+\.modal\.run', clean)))
    if len(urls) == 1:
        set_key(str(env_file), 'WANDER_BACKEND_URL', urls[0])
        print('Saved WANDER_BACKEND_URL in services/backend/.env.')
    else:
        print('Could not identify one backend URL. Copy the web endpoint above into WANDER_BACKEND_URL in .env.')
    run('deploy', '-m', 'services.backend.deployment.modal_annotations')
    # No secret needed: pure CV compute, no OpenAI/Elasticsearch/API-key usage.
    run('deploy', '-m', 'services.backend.deployment.modal_localization')
    print('All three Modal apps deployed. Scan imports can now read configuration from .env.')


if __name__ == '__main__':
    main()
