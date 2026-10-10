import ManagedSettings
import ManagedSettingsUI
import UIKit

// Dominus's block screen, in place of Apple's grey one.
//
// Apple allows a title, a subtitle, an icon, two buttons and their colours —
// nothing else, and nothing interactive beyond the buttons. That is why the
// cooldown and the task live in the app rather than here.
//
// The words are the extension's Blocked page, so a blocked app on the phone
// reads the same as a blocked site in Chrome: ACCESS DENIED, "You are in
// control.", and Stay focused beside Unlock.
//
// Only picked apps, categories and sites reach this screen. A site typed by
// name is stopped by the web content filter, which draws its own page and
// cannot be changed.
final class ShieldConfigurationExtension: ShieldConfigurationDataSource {
    private let gold = UIColor(red: 0xD4 / 255, green: 0xAF / 255, blue: 0x37 / 255, alpha: 1)
    private let parchment = UIColor(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xE5 / 255, alpha: 1)

    override func configuration(shielding application: Application) -> ShieldConfiguration {
        shield(naming: application.localizedDisplayName)
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        shield(naming: application.localizedDisplayName)
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        shield(naming: webDomain.domain)
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
        shield(naming: webDomain.domain)
    }

    private func shield(naming name: String?) -> ShieldConfiguration {
        let held = name.map { "\($0) is held." } ?? "This is held."
        return ShieldConfiguration(
            backgroundBlurStyle: .systemUltraThinMaterialDark,
            backgroundColor: .black,
            icon: UIImage(named: "Ornate_golden_shield_logo-removebg-preview"),
            title: ShieldConfiguration.Label(text: "ACCESS DENIED", color: gold),
            subtitle: ShieldConfiguration.Label(text: "\(held) You are in control.", color: parchment),
            primaryButtonLabel: ShieldConfiguration.Label(text: "Stay focused", color: .black),
            primaryButtonBackgroundColor: gold,
            secondaryButtonLabel: ShieldConfiguration.Label(text: "Unlock", color: gold)
        )
    }
}
