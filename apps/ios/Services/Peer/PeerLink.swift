import Foundation
import MultipeerConnectivity
import UIKit

/// Direct phone-to-phone link over Wi-Fi and Bluetooth. The front phone browses
/// and invites; side and back phones advertise. Messages are JSON `PeerMessage`s.
@MainActor
final class PeerLink: NSObject, ObservableObject {
    static let serviceType = "htn-navaid"

    @Published private(set) var connectedRoles: [DeviceRole] = []
    @Published private(set) var isRunning = false
    @Published private(set) var lastError: String?
    @Published private(set) var messagesSent = 0
    @Published private(set) var messagesReceived = 0

    let role: DeviceRole
    var onMessage: ((PeerMessage, DeviceRole?) -> Void)?

    private let peerID: MCPeerID
    nonisolated(unsafe) private let session: MCSession
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    /// Peers the browser can currently see, so a failed connection can be retried.
    private var visible: [String: MCPeerID] = [:]
    private var retryTasks: [String: Task<Void, Never>] = [:]
    /// Seconds before re-inviting a visible peer whose connection dropped or failed.
    var reinviteDelay: TimeInterval = 3
    private var rolesByPeer: [String: DeviceRole] = [:]

    init(role: DeviceRole) {
        self.role = role
        // Reuse one peer identity per role across launches. A fresh MCPeerID with the
        // same display name confuses peers that still remember the old one.
        peerID = Self.persistentPeerID(displayName: "\(role.rawValue)-\(UIDevice.current.name.prefix(20))")
        // .optional pairs with peers that use any preference; .none is deprecated and
        // fails the handshake between some iOS versions.
        session = MCSession(peer: peerID, securityIdentity: nil, encryptionPreference: .optional)
        super.init()
        session.delegate = self
    }

    private static func persistentPeerID(displayName: String) -> MCPeerID {
        let key = "peerID." + displayName
        if let data = UserDefaults.standard.data(forKey: key),
           let saved = try? NSKeyedUnarchiver.unarchivedObject(ofClass: MCPeerID.self, from: data),
           saved.displayName == displayName {
            return saved
        }
        let fresh = MCPeerID(displayName: displayName)
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: fresh, requiringSecureCoding: true) {
            UserDefaults.standard.set(data, forKey: key)
        }
        return fresh
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        if role == .front {
            let browser = MCNearbyServiceBrowser(peer: peerID, serviceType: Self.serviceType)
            browser.delegate = self
            browser.startBrowsingForPeers()
            self.browser = browser
            print("[peer] \(peerID.displayName) browsing for \(Self.serviceType)")
        } else {
            let advertiser = MCNearbyServiceAdvertiser(peer: peerID, discoveryInfo: ["role": role.rawValue], serviceType: Self.serviceType)
            advertiser.delegate = self
            advertiser.startAdvertisingPeer()
            self.advertiser = advertiser
            print("[peer] \(peerID.displayName) advertising \(Self.serviceType)")
        }
    }

    func stop() {
        browser?.stopBrowsingForPeers()
        advertiser?.stopAdvertisingPeer()
        browser = nil
        advertiser = nil
        session.disconnect()
        rolesByPeer = [:]
        connectedRoles = []
        isRunning = false
    }

    /// Sends to every connected peer, or only to the given roles.
    func send(_ message: PeerMessage, to roles: [DeviceRole]? = nil, reliable: Bool = true) {
        let peers = session.connectedPeers.filter { peer in
            guard let roles else { return true }
            guard let role = rolesByPeer[peer.displayName] else { return false }
            return roles.contains(role)
        }
        guard !peers.isEmpty, let data = try? JSONEncoder().encode(message) else { return }
        do {
            try session.send(data, toPeers: peers, with: reliable ? .reliable : .unreliable)
            messagesSent += 1
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func peerChanged(_ name: String, state: MCSessionState) {
        print("[peer] \(name) -> \(state.rawValue) (0=notConnected 1=connecting 2=connected)")
        switch state {
        case .connected:
            retryTasks[name]?.cancel()
            retryTasks[name] = nil
            if let raw = name.split(separator: "-").first, let role = DeviceRole(rawValue: String(raw)) {
                rolesByPeer[name] = role
            }
            send(.hello(role))
        case .notConnected:
            rolesByPeer[name] = nil
            scheduleReinvite(name)
        default:
            break
        }
        connectedRoles = session.connectedPeers.compactMap { rolesByPeer[$0.displayName] }.sorted { $0.rawValue < $1.rawValue }
    }

    /// An invitation can fail when the other phone still holds a session with our
    /// previous launch; it clears within seconds, so keep inviting while the peer is visible.
    private func scheduleReinvite(_ name: String) {
        guard browser != nil, visible[name] != nil else { return }
        retryTasks[name]?.cancel()
        retryTasks[name] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.reinviteDelay ?? 3))
            guard !Task.isCancelled, let self, let browser = self.browser, let peer = self.visible[name],
                  !self.session.connectedPeers.contains(peer) else { return }
            print("[peer] re-inviting \(name)")
            browser.invitePeer(peer, to: self.session, withContext: nil, timeout: 15)
        }
    }

    private func received(_ data: Data, from name: String) {
        guard let message = try? JSONDecoder().decode(PeerMessage.self, from: data) else { return }
        messagesReceived += 1
        if case .hello(let role) = message {
            rolesByPeer[name] = role
            connectedRoles = session.connectedPeers.compactMap { rolesByPeer[$0.displayName] }.sorted { $0.rawValue < $1.rawValue }
        }
        onMessage?(message, rolesByPeer[name])
    }
}

extension PeerLink: MCSessionDelegate {
    nonisolated func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        let name = peerID.displayName
        Task { @MainActor in self.peerChanged(name, state: state) }
    }
    nonisolated func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        let name = peerID.displayName
        Task { @MainActor in self.received(data, from: name) }
    }
    nonisolated func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    nonisolated func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    nonisolated func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension PeerLink: MCNearbyServiceAdvertiserDelegate {
    nonisolated func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        print("[peer] invitation from \(peerID.displayName), accepting")
        invitationHandler(true, session)
    }
    nonisolated func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        let message = error.localizedDescription
        print("[peer] advertising failed: \(message)")
        Task { @MainActor in self.lastError = message }
    }
}

extension PeerLink: MCNearbyServiceBrowserDelegate {
    nonisolated func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        print("[peer] found \(peerID.displayName) \(info ?? [:]), inviting")
        nonisolated(unsafe) let peer = peerID  // MCPeerID is not Sendable; it is only stored, never mutated
        Task { @MainActor in self.visible[peer.displayName] = peer }
        browser.invitePeer(peerID, to: session, withContext: nil, timeout: 15)
    }
    nonisolated func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        let name = peerID.displayName
        print("[peer] lost \(name)")
        Task { @MainActor in
            self.visible[name] = nil
            self.retryTasks[name]?.cancel()
            self.retryTasks[name] = nil
        }
    }
    nonisolated func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        let message = error.localizedDescription
        print("[peer] browsing failed: \(message)")
        Task { @MainActor in self.lastError = message }
    }
}
