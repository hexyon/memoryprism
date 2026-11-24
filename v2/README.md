# Memory Prism

A quiet, offline journal that keeps one memory at a time. Open `index.html` directly in a
browser — there is no build step, no server, and no network dependency.

## Using it

| Action | How |
| --- | --- |
| Keep what you wrote | **Keep this entry** button, or `Ctrl` + `Enter` |
| Edit a kept entry | **Edit** in the entry panel, change it, then **Update entry** |
| Read past entries | The 14-day grid, or **All entries** (with search) |
| Back up everything | **Save a copy** (`Ctrl` + `S`) — one JSON file with every entry |
| Restore / import | **Open a file** (`Ctrl` + `O`) — backups and old `.save` files both work |
| Export to Markdown | **Markdown** — the open entry, or the draft if nothing is open |
| Add a photo, video or sound | **Add media** (images are resized automatically) |
| Enlarge an image | Turn on **Focus images**, then click or tab to an image |
| Change theme | The sun/moon button; it follows your system setting by default |

`Escape` closes dialogs and cancels the logo animation. Every destructive action (keep,
delete, import) offers **Undo** in the toast for a few seconds.

## How your writing is stored

Everything lives in this browser's `localStorage` for the file — nothing is sent anywhere.

- The draft is saved automatically about half a second after you stop typing, and restored
  on reload.
- Entries are saved when you press **Keep**. A click on **Keep** with an empty editor does
  nothing, so it can never overwrite the entry you just kept.
- If the browser refuses the write (storage full), the app keeps your text in the editor and
  shows a warning with a one-click backup — it does not silently drop anything.
- The **Recent** card footer shows how much space entries are using. Browsers allow roughly
  5 MB per file; media is stored inline as base64, so this window fills quickly with photos.
  Use **Save a copy** to archive, then delete old entries if you run out.

Media limits: images are downscaled to 1800 px and re-encoded when they are large; a single
audio or video file is capped at about 1.4 MB. This keeps a text-first journal comfortably
inside the browser quota.

## Files

```
index.html                 markup, inlined SVG icon sprite, stylesheet/script links
app/app.js                 all application logic
styles/styles.css          the single stylesheet (light + dark themes)
styles/fonts.css           generated @font-face rules for the local fonts
fonts/                     local webfonts (Alegreya, Roboto, Test Signifier)
vendor/                    Quill 1.3.6, DOMPurify 3.3.0 (both local, no CDN)
vendor/icons.svg.html      source of the icon sprite that is inlined in index.html
tools/fetch-vendor.mjs     re-downloads the vendored assets (pinned versions)
```

The app is plain HTML, CSS and JavaScript with no framework and no bundler. Quill supplies the
rich-text editor; DOMPurify sanitises anything that arrives from an imported file.

## Notes and limits

- Imported HTML is sanitised before it is stored or rendered, so a file cannot run script.
- Backups are `{"app":"memory-prism","version":2,"entries":[...]}`. Legacy `.save` files
  (a single entry, or an array of entries) still import.
- There is no sync and no server component; copy backup files between machines if you need to.
- Quill 1.3.6 is intentionally pinned. A future move to Quill 2.x needs a check of the custom
  audio/video blots and the toolbar API.
