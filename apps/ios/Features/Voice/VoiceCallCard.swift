import SwiftUI
import UIKit

/// Front-screen card for the live voice guide: one large call button, the state, and the
/// last few caption fragments from both speakers. Built for VoiceOver first: every control
/// has a label, state changes are announced, and the pulse respects Reduce Motion.
struct VoiceCallCard: View {
    @ObservedObject var voice: VoiceCallController
    /// Settings allow a call (backend, key and voice token present, toggle on).
    let configured: Bool
    let error: String?
    let onStart: () -> Void
    let onEnd: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var typed = ""

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            HStack {
                Text("Voice guide")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: voice.state.label, fill: pillColor, foreground: voice.isActive ? .white : AppTheme.ink,
                        identifier: "front.voice.state")
            }
            if voice.captions.isEmpty {
                Text(configured
                     ? "Ask where you are, what is nearby, or say “guide me to Bed 1”."
                     : "Add the backend and voice token in Settings to enable the guide.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.inkSecondary)
            } else {
                captions
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.coral)
                    .accessibilityIdentifier("front.voice.error")
            }
            controls
            HStack(spacing: AppTheme.s8) {
                Text("AI-generated voice")
                if voice.usageSeconds > 0 {
                    Text("· \(Int(voice.usageSeconds.rounded())) s")
                }
                if voice.isMuted {
                    Text("· Muted")
                }
            }
            .font(.system(size: 12))
            .foregroundStyle(AppTheme.inkTertiary)
            .accessibilityElement(children: .combine)
        }
        .card()
        .accessibilityIdentifier("front.voice.card")
    }

    private var pillColor: Color {
        switch voice.state {
        case .idle: AppTheme.skyTint
        case .connecting, .reconnecting, .ending: AppTheme.graphite
        case .listening: AppTheme.primary
        case .speaking: AppTheme.midnight
        }
    }

    private var captions: some View {
        VStack(alignment: .leading, spacing: AppTheme.s8) {
            ForEach(voice.captions.suffix(6)) { caption in
                HStack {
                    if caption.speaker == "user" { Spacer(minLength: AppTheme.s24) }
                    Text(caption.text)
                        .font(.system(size: 15))
                        .foregroundStyle(caption.speaker == "user" ? .white : AppTheme.ink)
                        .padding(.vertical, AppTheme.s8)
                        .padding(.horizontal, AppTheme.s12)
                        .background(caption.speaker == "user" ? AppTheme.primary : AppTheme.skyTint)
                        .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusCard, style: .continuous))
                        .accessibilityLabel("\(caption.speaker == "user" ? "You" : "Guide"): \(caption.text)")
                    if caption.speaker != "user" { Spacer(minLength: AppTheme.s24) }
                }
            }
        }
        .accessibilityIdentifier("front.voice.captions")
    }

    private var controls: some View {
        VStack(spacing: AppTheme.s12) {
            HStack(spacing: AppTheme.s16) {
                Button(action: voice.isActive ? onEnd : onStart) {
                    Image(systemName: voice.isActive ? "phone.down.fill" : "waveform")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(voice.isActive ? AppTheme.coral : AppTheme.primary)
                        .clipShape(Circle())
                        .scaleEffect(pulse ? 1.06 : 1)
                        .animation(pulse ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: pulse)
                }
                .disabled(!configured && !voice.isActive)
                .opacity(!configured && !voice.isActive ? 0.5 : 1)
                .accessibilityLabel(voice.isActive ? "End voice call" : "Start voice call")
                .accessibilityHint(voice.isActive ? "" : "Talk to the guide about where you are and where to go")
                .accessibilityIdentifier(voice.isActive ? "front.voice.end" : "front.voice.start")

                VStack(alignment: .leading, spacing: AppTheme.s4) {
                    Text(voice.isActive ? "Tap to hang up" : "Tap to start a call")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(AppTheme.ink)
                    if let last = voice.lastAssistantText {
                        Text(last)
                            .font(.system(size: 13))
                            .foregroundStyle(AppTheme.inkSecondary)
                            .lineLimit(3)
                            .accessibilityIdentifier("front.voice.lastAnswer")
                    }
                }
                Spacer()
                if voice.isActive {
                    Button {
                        voice.toggleMute()
                    } label: {
                        Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(AppTheme.primary)
                            .frame(width: 44, height: 44)
                            .background(AppTheme.skyTint)
                            .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))
                    }
                    .accessibilityLabel(voice.isMuted ? "Unmute microphone" : "Mute microphone")
                    .accessibilityIdentifier("front.voice.mute")
                }
            }
            if voice.isActive {
                // Typed requests share the spoken path: the simulator has no microphone, and a loud room may not either.
                HStack(spacing: AppTheme.s8) {
                    TextField("Type a request", text: $typed)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.send)
                        .onSubmit(sendTyped)
                        .accessibilityIdentifier("front.voice.typed")
                    Button("Send", action: sendTyped)
                        .buttonStyle(GhostButtonStyle())
                        .frame(width: 80)
                        .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("front.voice.send")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .onChange(of: voice.state) { previous, state in
            // Announce call boundaries only; the guide's own speech should not be talked over.
            let announcement: String? = switch (previous, state) {
            case (.connecting, .listening): "Voice guide connected"
            case (_, .reconnecting): "Voice guide reconnecting"
            case (_, .idle): "Voice guide ended"
            default: nil
            }
            if let announcement {
                UIAccessibility.post(notification: .announcement, argument: announcement)
            }
        }
    }

    private var pulse: Bool { voice.state == .listening && !reduceMotion }

    private func sendTyped() {
        let text = typed
        typed = ""
        voice.send(text: text)
    }
}
