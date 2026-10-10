import SwiftUI
import FamilyControls

// The pieces every tab is built from.

// A titled block on the raised plane — Tokens.css's --section.
//
// `glowing` is for the one thing on a screen that has just changed and that
// the user came here for: an unlock request from the block screen, a timer
// that has just started. In build 4 the timer appeared two sections away from
// the site that had been unlocked, and went unnoticed. Whatever just changed
// has to draw the eye.
//
// `info` is the phone's tooltip. There is no hovering on a touch screen, so a
// figure that needs a sentence of explanation carries a small (i) beside its
// title, and tapping it shows the sentence. The first Keep on a phone showed
// "0 stands" over "Longest 4 stands" and was read as no stands at all.
struct Panel<Content: View>: View {
    private let title: String
    private let info: String?
    private let glowing: Bool
    private let content: Content

    @State private var infoShown = false

    init(_ title: String, info: String? = nil, glowing: Bool = false, @ViewBuilder content: () -> Content) {
        self.title = title
        self.info = info
        self.glowing = glowing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title.uppercased())
                    .font(.caption.monospaced())
                    .tracking(2)
                    .foregroundStyle(glowing ? Theme.gold : Theme.goldDim)
                if info != nil {
                    Button {
                        infoShown.toggle()
                    } label: {
                        Image(systemName: infoShown ? "info.circle.fill" : "info.circle")
                            .font(.footnote)
                            .foregroundStyle(Theme.gold)
                    }
                    .accessibilityLabel("What \(title) means")
                }
            }
            if let info, infoShown {
                Text(info)
                    .font(.footnote)
                    .foregroundStyle(Theme.parchment)
            }
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.section)
        .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
        .modifier(Glow(active: glowing))
    }
}

// A gold border that breathes. Held steady and bright for anyone who has
// asked the phone to reduce motion: the point is to be noticed, and that does
// not need movement.
struct Glow: ViewModifier {
    let active: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var bright = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if active {
            content
                .overlay(
                    Rectangle()
                        .stroke(Theme.gold, lineWidth: 2)
                        .opacity(reduceMotion || bright ? 1 : 0.35)
                )
                .shadow(color: Theme.gold.opacity(reduceMotion || bright ? 0.5 : 0.12), radius: 14)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                        bright = true
                    }
                }
        } else {
            content
        }
    }
}

// Gold on black for the thing to do; outlined for the thing you may do instead.
struct GoldButton: View {
    private let title: String
    private let secondary: Bool
    private let action: () -> Void

    init(_ title: String, secondary: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.secondary = secondary
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title.uppercased())
                .font(.subheadline.weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(secondary ? Theme.gold : Theme.ground)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(secondary ? Color.clear : Theme.gold)
                .overlay(Rectangle().stroke(Theme.gold, lineWidth: secondary ? 1 : 0))
        }
    }
}

// The extension's artwork, bundled from the repository's Assets folder as it
// is. Nothing if the picture is missing: it is decoration, and a page must not
// depend on it.
struct Emblem: View {
    let name: String
    var height: CGFloat = 64

    var body: some View {
        if let image = UIImage(named: name) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(height: height)
                // Purely decorative: it labels nothing, and a screen reader
                // announcing it between figures would be noise.
                .accessibilityHidden(true)
        }
    }
}

// The scrolling black page each tab sits on, under its name, with the emblem
// the extension gives the same section.
struct Page<Content: View>: View {
    private let title: String
    private let subtitle: String?
    private let emblem: String?
    private let content: Content

    init(_ title: String, subtitle: String? = nil, emblem: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.emblem = emblem
        self.content = content()
    }

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(title.uppercased())
                                .font(.display(30, relativeTo: .largeTitle))
                                .tracking(2)
                                .foregroundStyle(Theme.gold)
                            if let subtitle {
                                Text(subtitle)
                                    .font(.footnote)
                                    .foregroundStyle(Theme.goldDim)
                            }
                        }
                        Spacer(minLength: 0)
                        if let emblem {
                            Emblem(name: emblem)
                        }
                    }
                    content
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// Whatever a LockTarget names, drawn the way the app draws it everywhere.
struct TargetLabel: View {
    let target: LockTarget

    var body: some View {
        switch target {
        case .application(let token): Label(token)
        case .webDomain(let token): Label(token)
        case .category(let token): Label(token)
        case .site(let domain): Label(domain, systemImage: "globe")
        }
    }
}

// A request to take the whole fortress down, while it waits and once it can
// be confirmed. Shown on The Keep, where it glows, and in The Fortress beside
// the button that started it.
struct StandDownStatus: View {
    @EnvironmentObject private var fortress: Fortress

    var body: some View {
        switch fortress.standDown {
        case .none:
            EmptyView()

        case .waiting(let until):
            (Text("The fortress stays up for now. It can come down in ") + Text(until, style: .relative) + Text("."))
                .foregroundStyle(Theme.parchment)
            Text("Nothing has changed, and nothing will unless you confirm it then. You don't need to wait here.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
            GoldButton("Keep it standing") { fortress.cancelStandDown() }

        case .ready(let until):
            Text("The wait is over. The fortress can come down now, and everything on this phone stops being blocked.")
                .foregroundStyle(Theme.parchment)
            (Text("If you do nothing, it stays up. This offer lapses in ") + Text(until, style: .relative) + Text("."))
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
            GoldButton("Keep it standing") { fortress.cancelStandDown() }
            GoldButton("Take it down now", secondary: true) { fortress.confirmStandDown() }
        }
    }
}
