import SwiftUI

/// The notes pinned to this world in the web viewer, nearest first.
///
/// This is the surface that always works: the notes load straight from the
/// backend, so they can be read before ever reaching the building. Distances and
/// directions fill in once the phone has a precise fix, and the camera overlay
/// takes over when one is available.
struct WorldNotesView: View {
    @ObservedObject var store: WorldNotesStore
    /// True while the VPS anchor is tracked, i.e. distances can be trusted.
    let localized: Bool
    let worldId: String
    let onReload: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.isEmpty {
                    empty
                } else {
                    list
                }
            }
            .background(AppTheme.canvas.ignoresSafeArea())
            .navigationTitle("Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reload", systemImage: "arrow.clockwise", action: onReload)
                        .accessibilityIdentifier("notes.reload")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("notes.done")
                }
            }
        }
    }

    private var list: some View {
        ScrollView {
            VStack(spacing: AppTheme.s12) {
                if !localized {
                    banner
                }
                ForEach(rows, id: \.note.id) { row in
                    NoteRow(bearing: row, showsDistance: localized)
                }
            }
            .padding(.horizontal, AppTheme.s16)
            .padding(.vertical, AppTheme.s16)
        }
    }

    /// Ranked rows when there is a pose, otherwise the plain list in stored order.
    private var rows: [NoteBearing] {
        if localized, !store.bearings.isEmpty { return store.bearings }
        return store.notes.map { NoteBearing(note: $0, distance: .nan, bearingDeg: 0, heightDelta: 0) }
    }

    private var banner: some View {
        HStack(alignment: .top, spacing: AppTheme.s8) {
            Image(systemName: "location.slash")
                .font(.system(size: 14))
                .foregroundStyle(AppTheme.graphite)
            Text("Not localized to the map yet — distances and directions appear once the phone gets a precise fix.")
                .font(.system(size: 13))
                .foregroundStyle(AppTheme.inkSecondary)
        }
        .padding(AppTheme.s12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.skyTint)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("notes.notLocalized")
    }

    private var empty: some View {
        VStack(spacing: AppTheme.s12) {
            Image(systemName: store.state == .loading ? "clock" : "note.text")
                .font(.system(size: 30))
                .foregroundStyle(AppTheme.inkTertiary)
            Text(emptyTitle)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(AppTheme.ink)
            Text(emptyDetail)
                .font(.system(size: 14))
                .foregroundStyle(AppTheme.inkSecondary)
                .multilineTextAlignment(.center)
            if case .failed = store.state {
                Button("Try again", action: onReload)
                    .buttonStyle(GhostButtonStyle())
                    .padding(.top, AppTheme.s8)
            }
        }
        .padding(AppTheme.s32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("notes.empty")
    }

    private var emptyTitle: String {
        switch store.state {
        case .loading: "Loading notes"
        case .failed: "Could not load notes"
        default: "No notes yet"
        }
    }

    private var emptyDetail: String {
        switch store.state {
        case .failed(let why): why
        case .loading: "Fetching from the worlds API."
        default: worldId.isEmpty
            ? "Scan a world QR code first, then reload."
            : "Pin notes to the scan in the web viewer and they will show up here."
        }
    }
}

private struct NoteRow: View {
    let bearing: NoteBearing
    let showsDistance: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.s8) {
            HStack(alignment: .firstTextBaseline) {
                Text(bearing.note.title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AppTheme.ink)
                Spacer(minLength: AppTheme.s8)
                if showsDistance, bearing.distance.isFinite {
                    Text(String(format: "%.1f m", bearing.distance))
                        .font(.system(size: 15, weight: .medium, design: .monospaced))
                        .foregroundStyle(AppTheme.ink)
                }
            }
            if let location = bearing.note.location, !location.isEmpty {
                Text(location)
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.inkSecondary)
            }
            if let description = bearing.note.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showsDistance, bearing.distance.isFinite {
                HStack(spacing: AppTheme.s8) {
                    PillTag(text: directionText, fill: AppTheme.skyTint, foreground: AppTheme.primary)
                    if abs(bearing.heightDelta) >= 1 {
                        PillTag(text: bearing.heightDelta > 0 ? "above" : "below",
                                fill: AppTheme.canvas, foreground: AppTheme.inkSecondary)
                    }
                }
            }
        }
        .card()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var directionText: String {
        switch bearing.side {
        case .ahead: "Ahead"
        case .left: String(format: "Left %.0f°", abs(bearing.bearingDeg))
        case .right: String(format: "Right %.0f°", abs(bearing.bearingDeg))
        case .behind: "Behind"
        }
    }

    private var accessibilityText: String {
        var parts = [bearing.note.title]
        if let location = bearing.note.location, !location.isEmpty { parts.append(location) }
        if showsDistance, bearing.distance.isFinite {
            parts.append(String(format: "%.0f metres %@", bearing.distance.rounded(), bearing.side.spoken))
        }
        if let description = bearing.note.description, !description.isEmpty { parts.append(description) }
        return parts.joined(separator: ", ")
    }
}
