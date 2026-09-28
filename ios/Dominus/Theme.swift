import SwiftUI

// The colours from Styles/Tokens.css, by the same names. That file is still
// the only place a colour is decided; these are copied by hand for now and
// should be generated from it once there are more than a handful.
enum Theme {
    static let ground = Color(hex: 0x000000)
    static let panel = Color(hex: 0x0D0D0D)
    static let section = Color(hex: 0x14110B)
    static let gold = Color(hex: 0xD4AF37)
    static let goldDim = Color(hex: 0x8B6F1A)
    static let parchment = Color(hex: 0xE5E5E5)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
