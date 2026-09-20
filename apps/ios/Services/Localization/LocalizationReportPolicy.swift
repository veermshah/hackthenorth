import Foundation
import simd

/// Decides what the backend hears about each SDK fix.
///
/// A new fix goes out as a VPS fix (`/localize`); between fixes the ARKit pose is posted against
/// the fix's anchor (`/sessions/{id}/pose`). VPS answers come in bursts with `notTracked` gaps
/// between them, and ARKit keeps tracking relative to the last anchor through those gaps, so a
/// tracked fix is *held* for `maxAge`: poses keep flowing from its anchor and the backend is told
/// `lost` only once the anchor has not been tracked again for that long. Without the hold every
/// gap marked the backend session lost, the voice guide announced "tracking lost" and answered
/// "where am I" with nothing while the wearer was still localized.
///
/// Pure, so the hold can be tuned and tested without the SDK.
struct LocalizationReportPolicy {
    enum Action: Equatable {
        /// A changed fix: post it as a VPS fix.
        case fix(LocalizationFix)
        /// Post the ARKit pose against this fix's anchor.
        case pose(using: LocalizationFix)
        /// Nothing new worth sending.
        case skip
    }

    /// How long a tracked anchor is trusted after the SDK stops confirming it.
    var maxAge: TimeInterval = 10

    private(set) var held: (fix: LocalizationFix, at: Date)?
    private var lastReported: LocalizationFix?

    /// The fix the backend is currently being fed poses against, if any.
    var reporting: LocalizationFix? { held?.fix }

    mutating func decide(_ fix: LocalizationFix, now: Date = Date()) -> Action {
        if fix.state == .localized {
            held = (fix, now)
        } else if let current = held {
            if now.timeIntervalSince(current.at) <= maxAge {
                return .pose(using: current.fix)
            }
            held = nil
        }
        if fix != lastReported {
            lastReported = fix
            return .fix(fix)
        }
        return fix.state == .lost ? .skip : .pose(using: fix)
    }

    /// Localization restarted: nothing already sent applies to the new session.
    mutating func reset() {
        held = nil
        lastReported = nil
    }
}
