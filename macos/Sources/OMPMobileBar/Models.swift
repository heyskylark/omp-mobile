import Foundation

struct ServerFile: Decodable, Sendable {
    let port: Int
    let pid: Int32
    let adminToken: String

    func validated() throws -> ServerFile {
        guard (1...65_535).contains(port), pid > 0, !adminToken.isEmpty else {
            throw AdminError.invalidServerFile
        }
        return self
    }
}

struct AdminStatus: Decodable, Sendable {
    struct Device: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
        let pairedAt: String
        let lastSeenAt: String?
    }

    struct Live: Decodable, Sendable {
        let server: Int
        let terminal: Int
        let pending: Int
    }

    let machineName: String
    let url: String
    let ompVersion: String?
    let apnsConfigured: Bool
    let devices: [Device]
    let live: Live
    let problems: [String]
}

struct AdminPairing: Decodable, Sendable {
    let code: String
    let expiration: Date
    let pairingUrl: String

    private enum CodingKeys: String, CodingKey {
        case code
        case expiresAt
        case pairingUrl
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        code = try values.decode(String.self, forKey: .code)
        pairingUrl = try values.decode(String.self, forKey: .pairingUrl)
        let rawExpiration = try values.decode(String.self, forKey: .expiresAt)
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var parsed = parser.date(from: rawExpiration)
        if parsed == nil {
            parser.formatOptions = [.withInternetDateTime]
            parsed = parser.date(from: rawExpiration)
        }
        guard let parsed else {
            throw DecodingError.dataCorruptedError(
                forKey: .expiresAt,
                in: values,
                debugDescription: "Expected an ISO 8601 timestamp"
            )
        }
        expiration = parsed
    }
}

enum ServerState: Sendable {
    case offline(String)
    case online(AdminStatus)

    var menuBarMark: MenuBarMark {
        switch self {
        case .offline:
            return .offline
        case .online(let status) where status.live.pending > 0:
            return .waiting
        case .online(let status) where !status.problems.isEmpty || !status.apnsConfigured:
            return .problem
        case .online:
            return .online
        }
    }
}

enum AdminError: LocalizedError {
    case invalidServerFile
    case invalidResponse
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .invalidServerFile:
            return "Server configuration is invalid"
        case .invalidResponse:
            return "The server returned an invalid response"
        case .server(let status):
            return "The server returned HTTP \(status)"
        }
    }
}
