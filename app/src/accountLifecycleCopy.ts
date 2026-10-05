/** User-facing account lifecycle, backed by build31-identity-lifecycle.md. */
export const ACCOUNT_LIFECYCLE_COPY = {
  title: 'Deleting your account and starting again',
  summary:
    'After Delete my account finishes, setting up again creates a new Tacendum ID with no old rooms — even on the same device.',
  details: [
    'Deletion clears your account, rooms and profile here. Your old Tacendum ID is retired and cannot be restored.',
    'Other people keep their copies of your messages. Other linked devices keep their own accounts and data.',
    'Restarting, updating or offloading Tacendum keeps your ID and saved data. Removing the app is different from deleting your account: a full reinstall normally creates a new ID, but does not confirm deletion of the old server account.',
    'Verifying the same email again does not bring back a deleted ID or its message history. Recovery can only connect you to an account that still exists.',
    'Some installation preferences, such as screen-sharing protection, may remain. They do not restore your old account or rooms.',
    'If deletion cannot finish, follow the retry message. A failed or interrupted deletion is not confirmation that your account and data have been removed.',
  ],
} as const;
