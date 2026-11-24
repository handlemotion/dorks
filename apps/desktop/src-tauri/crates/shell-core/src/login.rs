//! Open at login: the server, and so every automation schedule, runs only while the app does. A schedule booked for the night
//! fires on time only if the app is open then, so while an active automation has a schedule the app registers itself as a login
//! item, and removes the login item it added once none has.

use crate::settings::OpenAtLogin;

/// What to do with the login item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginItemChange {
    Register,
    Unregister,
}

/// Decides from the setting, whether an active automation has a schedule, and whether the app already registered the login item.
/// Registers at most once per stretch of schedules, so a login item the owner turned off in System Settings stays off.
pub fn login_item_change(mode: OpenAtLogin, scheduled: bool, registered: bool) -> Option<LoginItemChange> {
    match (mode, scheduled, registered) {
        (OpenAtLogin::WhileScheduled, true, false) => Some(LoginItemChange::Register),
        (OpenAtLogin::WhileScheduled, false, true) | (OpenAtLogin::Never, _, true) => Some(LoginItemChange::Unregister),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use LoginItemChange::*;
    use OpenAtLogin::*;

    #[test]
    fn registers_while_scheduled_and_removes_only_its_own() {
        assert_eq!(login_item_change(WhileScheduled, true, false), Some(Register));
        assert_eq!(login_item_change(WhileScheduled, true, true), None, "already added: a login item the owner turned off stays off");
        assert_eq!(login_item_change(WhileScheduled, false, true), Some(Unregister), "the last schedule went away");
        assert_eq!(login_item_change(WhileScheduled, false, false), None, "never added: nothing of ours to remove");
        assert_eq!(login_item_change(Never, true, false), None);
        assert_eq!(login_item_change(Never, true, true), Some(Unregister), "turned off after it was added");
    }
}
