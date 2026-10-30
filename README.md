# Filing Cabinet

A digital filing cabinet that runs entirely in your browser. No server, no account, no dependencies.

## Features

- **Drawers → folders → files.** Make labeled, color-coded drawers. Nest folders as deep as you like.
- **File anything.** Upload any file type with the button or by dragging it from your desktop, or write quick text notes.
- **Preview.** Images, PDFs, video, audio and text files open right in the app.
- **Organize.** Drag files and folders onto other folders or drawers to move them. Rename, recolor and delete.
- **Tags & notes.** Tag files and add notes. Click a tag to see everything with that tag.
- **Search.** Search names, tags, notes and note text across the whole cabinet (press `/` to jump to search).
- **Backup.** **Export** downloads everything (files included) as one JSON file. **Import** restores it.

## Running it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Where your data lives

Everything is stored locally in your browser's IndexedDB. Nothing is uploaded anywhere. That also means
your files stay in that one browser on that one device. Use **Export** regularly to keep a backup.
