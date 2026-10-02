import Foundation

// The fortress as the extension stores it — categories, sites blocked by hand,
// the unlock task, the cooldown — read from and written back through Seal.js.
//
// A category and a task are kept as the JSON they arrived as, with typed
// accessors over the fields the phone edits, rather than decoded into structs
// of the fields it knows. That is deliberate. A struct rebuilds an object from
// the keys it has heard of, so a field added by a newer extension — a
// category's own task, say — would be dropped the first time the phone saved,
// and read by a peer as a decision to remove it. The project has paid for that
// lesson once already; see "Peers of two vintages".

enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var strings: [String] {
        if case .array(let values) = self { return values.compactMap(\.string) }
        return []
    }
}

struct FortressPlan: Decodable {
    var categories: [Category]
    var manualSites: [String]
    var task: UnlockTask?
    var cooldown: Cooldown

    // Derived by the extension's computeBlockedSites(): every enabled
    // category's sites, and the ones blocked by hand.
    let blockedSites: [String]

    // The extension's own constants, read rather than repeated.
    let palette: [Swatch]
    let taskTypes: [TaskType]
    let removeCooldownSeconds: Int
    let minCooldownSeconds: Int
    let maxCooldownSeconds: Int
    let minEscalationFactor: Double

    struct Category: Codable, Equatable, Identifiable {
        var fields: [String: JSONValue]

        init(from decoder: Decoder) throws {
            fields = try decoder.singleValueContainer().decode([String: JSONValue].self)
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(fields)
        }

        // A category made on the phone. The id has the shape Categories.js
        // gives one it mints itself, and its banner is left for
        // normalizeCategory() to choose.
        init(name: String, sites: [String]) {
            fields = [
                "id": .string("custom-\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 0..<1000))"),
                "name": .string(name),
                "sites": .array(sites.map(JSONValue.string)),
                "enabled": .bool(true)
            ]
        }

        var id: String { fields["id"]?.string ?? "" }

        var name: String {
            get { fields["name"]?.string ?? "Untitled" }
            set { fields["name"] = .string(newValue) }
        }

        var sites: [String] {
            get { fields["sites"]?.strings ?? [] }
            set { fields["sites"] = .array(newValue.map(JSONValue.string)) }
        }

        var enabled: Bool {
            get { fields["enabled"]?.bool ?? false }
            set { fields["enabled"] = .bool(newValue) }
        }

        var color: String { fields["color"]?.string ?? "gold" }
        var glyph: String { fields["glyph"]?.string ?? "◆" }
    }

    // null in storage is "no task": the unlock goes straight to the cooldown.
    struct UnlockTask: Codable, Equatable {
        var fields: [String: JSONValue]

        init(from decoder: Decoder) throws {
            fields = try decoder.singleValueContainer().decode([String: JSONValue].self)
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(fields)
        }

        // The three shapes the blocked page understands.
        static func reflection(_ message: String) -> UnlockTask {
            UnlockTask(fields: ["type": .string("cooldown"), "message": .string(message)])
        }

        static let passage = UnlockTask(fields: ["type": .string("passage")])

        static func code(_ code: String) -> UnlockTask {
            UnlockTask(fields: ["type": .string("code"), "code": .string(code)])
        }

        private init(fields: [String: JSONValue]) {
            self.fields = fields
        }

        var type: String { fields["type"]?.string ?? "" }
        var message: String { fields["message"]?.string ?? "" }
        var code: String { fields["code"]?.string ?? "" }
    }

    struct Cooldown: Codable, Equatable {
        var seconds: Int
        var escalate: Bool
        var factor: Double

        // The shape Tasks.js's effectiveCooldownSeconds() takes.
        var dictionary: [String: Any] {
            ["seconds": seconds, "escalate": escalate, "factor": factor]
        }
    }

    struct Swatch: Decodable {
        let id: String
        let value: String
    }

    struct TaskType: Decodable, Identifiable {
        let id: String
        let title: String
        let tooltip: String
    }

    func title(ofTask type: String) -> String {
        taskTypes.first { $0.id == type }?.title ?? "Unknown task"
    }

    func hex(of category: Category) -> String {
        palette.first { $0.id == category.color }?.value ?? "#D4AF37"
    }
}

// The task and cooldown that govern one unlock, as Bridge.js resolves them.
struct Standards: Decodable {
    let task: FortressPlan.UnlockTask?
    let cooldown: FortressPlan.Cooldown
    let permanent: Bool
}

// An edit to the fortress: only the keys it names, as fillFortressState()
// expects. A key left out is left alone; `task: null` clears the task.
struct FortressEdit {
    private(set) var fields: [String: JSONValue] = [:]

    static func categories(_ categories: [FortressPlan.Category]) -> FortressEdit {
        FortressEdit(fields: ["categories": .array(categories.map { .object($0.fields) })])
    }

    static func manualSites(_ sites: [String]) -> FortressEdit {
        FortressEdit(fields: ["manualSites": .array(sites.map(JSONValue.string))])
    }

    static func standards(task: FortressPlan.UnlockTask?, cooldown: FortressPlan.Cooldown) -> FortressEdit {
        FortressEdit(fields: [
            "task": task.map { .object($0.fields) } ?? .null,
            "cooldown": .object([
                "seconds": .number(Double(cooldown.seconds)),
                "escalate": .bool(cooldown.escalate),
                "factor": .number(cooldown.factor)
            ])
        ])
    }

    var data: Data {
        (try? JSONEncoder().encode(fields)) ?? Data("{}".utf8)
    }
}
