# Replay-note backups and restore

Export keeps a copy of your saved replay notes outside the app. Import restores an exported
collection or combines it with notes already on this computer. These files contain note text
and replay links, not the hosted battle replay, teams, launcher settings or Showdown login.

## Save and move a backup

1. Save any current edits, then choose **Export notes…** in Replay notes.
2. Choose a JSON file outside the app's data folder. All saved notes are included, regardless
   of search or format filters. An existing file is replaced only through the native Save dialog.
3. Keep the file somewhere you control. Private replay links keep their access suffix, so
   anyone with the exported file can read those links. No backup is uploaded by the app.

Export leaves unsaved drafts and the saved collection alone. Failed exports leave the
previous destination file intact. Export is manual; the app does not schedule backups.

## Review and import

Choose **Import notes…** and select a file previously exported from Replay notes. Selecting
or previewing the file does not change your saved collection. The review window shows a
count and list of new, unchanged and conflicting notes. Use **Show** to narrow the list,
then select a note to compare its existing and imported versions.

| Result | Meaning | Import behavior |
| --- | --- | --- |
| New | No saved note has this exact replay link. | Add the imported note with its saved dates. |
| Unchanged | The replay link, title, format and notes match. | Skip it; keep the existing note's ID and dates. |
| Conflict | The replay link matches, but the title, format or notes differ. | Keep the existing version unless you explicitly choose **Use imported note**. |

Use **Keep all existing** or **Use all imported** for the conflicts as a group. Individual
choices remain editable afterward. The footer reports how many notes will be added and
replaced before you press **Import notes**. That button applies the reviewed choices in
one atomic write. There is no partial import when a validation or write fails.

Notes that are not present in the file are always retained. Choosing an imported version
replaces that note's title, format, body and saved dates, while keeping its local ID. Private
replay links are matched in full; different access suffixes are not combined. New notes
whose IDs collide with unrelated local notes receive a fresh ID.

For a new or empty profile, this restores the exported collection. For a profile that already
has notes, it merges them. Import does not erase the whole collection to mirror a backup.
Cancel or Escape closes the preview without applying any choices.

## Drafts and undo

You can inspect a backup with an unsaved draft open, but cannot apply it until that draft
is saved. Cancel the preview, save the draft, then choose the file again. Canceling the
preview never discards your draft. Import and undo never upload or open a replay.

After an import that changes notes, **Undo import…** restores the saved collection from
immediately before it. The confirmation keeps the imported collection by default. Undo
is available across launcher page changes, but only within the current app session and
while the saved collection remains unchanged. Saving/deleting a note, resetting launcher
data or restarting the app makes that undo unavailable. Unsaved drafts must be dealt with
before undo; the app never discards them on your behalf.

Only the most recent import that changed notes is undoable. A preview or an import with
no changes does not replace that undo state. Keep exported files for recovery across
restarts; session undo is not a persistent backup history.

## Validation and failures

- Supported files use the app's version 1 export format and must be at most 8 MiB. Unknown
  versions, malformed records, duplicate IDs/links within the file, invalid replay URLs
  and invalid dates are rejected. Every record must pass; invalid records are not silently skipped.
- The resulting collection must stay within 1,000 notes and 8 MiB. Existing text limits
  remain 120 characters for a title and 5,000 for note text. Imports never truncate notes to fit.
- If saved notes change while a preview is open, the app refuses to apply the old preview.
  Close it and choose the backup again to review the latest state. The file itself is read
  into a validated snapshot: changes to that file after preview do not alter what is applied.
- Write failures preserve the previous saved collection. Choose a writable storage location
  or resolve the disk problem before retrying. An unsuccessful undo leaves imported notes intact.
- An unreadable or corrupt local collection blocks import rather than overwriting it.
  Automatic repair of corrupt stores is not part of this feature. Keep the original file
  and your exported backup for diagnosis; do not reset launcher data as a repair shortcut.

The import file is never modified. File paths are chosen through native dialogs; the
Showdown client has no import/export bridge. Imported text is displayed as text, never HTML.
