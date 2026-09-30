import DeviceActivity
import ManagedSettings

// Puts a block back when an unlock runs out.
//
// The app cannot do this itself: it is not running fifteen minutes later, and
// an unlock that only ended when someone next opened Dominus would be no end
// at all. So every unlock starts a DeviceActivity timer of its own length, and
// iOS wakes this extension when that timer's interval ends.
//
// It rebuilds everything from the fortress in the App Group rather than
// re-blocking only the one thing, so a timer arriving late, early or twice
// can only ever leave the fortress as it should be.
final class MonitorExtension: DeviceActivityMonitor {
    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)

        guard var state = FortressState.load() else { return }
        // A minute's slack: the timer's end is rounded up to a whole minute,
        // and iOS may wake this a few seconds either side of it.
        let ended = state.pruneExpired(at: Date(), slack: 60)
        state.save()
        state.apply(to: ManagedSettingsStore())

        let names = ended.map { DeviceActivityName($0.id) } + [activity]
        DeviceActivityCenter().stopMonitoring(names)
    }
}
