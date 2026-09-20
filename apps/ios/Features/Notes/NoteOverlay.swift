import SwiftUI

/// One note projected into the camera preview's coordinate space.
struct NotePin: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let distance: Float
    /// Position inside the preview, in points.
    let point: CGPoint
}

/// Note labels drawn over the live camera feed.
///
/// Only shown while the VPS anchor is `tracked`: per the NSDK docs a `limited`
/// anchor is a coarse, GPS-derived guess, and pinning labels to the world with
/// one would put them tens of metres from the thing they describe. When the fix
/// is not precise the overlay steps aside and the list in `WorldNotesView`
/// carries the information instead.
struct NoteOverlay: View {
    let pins: [NotePin]
    /// Reports the preview's size back so the pipeline can project into it.
    let onSize: (CGSize) -> Void

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                ForEach(pins) { pin in
                    NoteLabel(title: pin.title, distance: pin.distance)
                        .position(clamped(pin.point, in: geo.size))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .onAppear { onSize(geo.size) }
            .onChange(of: geo.size) { _, size in onSize(size) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true) // the list is the accessible surface
    }

    /// Keep a label fully on screen; a pin just off the edge still reads as "over there".
    private func clamped(_ point: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(x: min(max(point.x, 56), max(56, size.width - 56)),
                y: min(max(point.y, 18), max(18, size.height - 18)))
    }
}

private struct NoteLabel: View {
    let title: String
    let distance: Float

    var body: some View {
        HStack(spacing: AppTheme.s4) {
            Image(systemName: "mappin.circle.fill")
                .font(.system(size: 12))
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
            Text(String(format: "%.1f m", distance))
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.8))
        }
        .foregroundStyle(.white)
        .padding(.vertical, AppTheme.s4)
        .padding(.horizontal, AppTheme.s8)
        .background(AppTheme.midnight.opacity(0.82))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.25), lineWidth: 1))
        .fixedSize()
    }
}
