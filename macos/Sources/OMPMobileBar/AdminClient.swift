import Foundation

struct AdminClient: Sendable {
    let home: URL
    private let decoder = JSONDecoder()

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        if let override = environment["OMP_MOBILE_HOME"], !override.isEmpty {
            home = URL(fileURLWithPath: override, isDirectory: true)
        } else {
            home = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".omp-mobile", isDirectory: true)
        }
    }

    func readServerFile() throws -> ServerFile {
        let data = try Data(contentsOf: home.appendingPathComponent("server.json"))
        return try decoder.decode(ServerFile.self, from: data).validated()
    }

    func status() async throws -> AdminStatus {
        let server = try readServerFile()
        return try await request(server: server, method: "GET", path: "/admin/status")
    }

    func createPairing() async throws -> AdminPairing {
        let server = try readServerFile()
        return try await request(server: server, method: "POST", path: "/admin/pairing")
    }

    func removeDevice(id: String) async throws {
        let server = try readServerFile()
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let _: EmptyResponse = try await request(
            server: server,
            method: "DELETE",
            path: "/admin/devices/\(encoded)"
        )
    }

    private func request<Response: Decodable>(
        server: ServerFile,
        method: String,
        path: String
    ) async throws -> Response {
        guard let url = URL(string: "http://127.0.0.1:\(server.port)\(path)") else {
            throw AdminError.invalidServerFile
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 4
        request.setValue("Bearer \(server.adminToken)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AdminError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AdminError.server(http.statusCode)
        }
        if Response.self == EmptyResponse.self, data.isEmpty {
            return EmptyResponse() as! Response
        }
        return try decoder.decode(Response.self, from: data)
    }
}

private struct EmptyResponse: Decodable, Sendable {}
