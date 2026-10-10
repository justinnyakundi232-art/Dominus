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

extension Color {
    // "#D4AF37", as Categories.js's CATEGORY_COLORS gives a banner's colour.
    // Gold for anything it cannot read, as categoryColorValue() falls back.
    init(hexString: String) {
        let digits = hexString.hasPrefix("#") ? String(hexString.dropFirst()) : hexString
        self.init(hex: UInt32(digits, radix: 16) ?? 0xD4AF37)
    }
}

extension Font {
    // Playfair Display, the extension's and the desktop app's typeface for
    // headings and figures. Bundled as one variable font (Fonts/), the same
    // family under the same licence as the copy in Styles/fonts — that one is
    // a web font, which an iPhone app cannot load.
    //
    // Sized against a text style so it still grows with the reader's chosen
    // text size. If the font is ever missing, iOS falls back to the system
    // face rather than failing.
    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle = .title, bold: Bool = true) -> Font {
        Font.custom("Playfair Display", size: size, relativeTo: style).weight(bold ? .bold : .regular)
    }
}
