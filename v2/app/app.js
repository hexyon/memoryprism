/* ============================================================================
   Memory Prism — application logic.
   No build step: this file is loaded directly by index.html.

   Storage note: entries and the draft live in localStorage. IndexedDB is not
   available when the page is opened from disk (file://), which is the normal
   way to use this app, so localStorage is the one store that always works.
   ========================================================================== */
(function () {
    'use strict';

    /* ---------------------------------------------------------------- config */

    var KEY_ENTRIES = 'memoryprism.entries.v1';
    var KEY_DRAFT = 'memoryprism.draft.v1';
    var KEY_THEME = 'memoryprism.theme.v1';
    var KEY_FOCUS = 'memoryprism.focus.v1';

    // Base64 inflates by ~33%; localStorage gives roughly 5 MB per origin.
    var MAX_MEDIA_BYTES = 1.4 * 1024 * 1024;
    var IMAGE_SHRINK_ABOVE = 700 * 1024;
    var IMAGE_MAX_EDGE = 1800;

    /* --------------------------------------------------------------- helpers */

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function pad(n) { return String(n).padStart(2, '0'); }
    function dayKey(date) {
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }
    function startOfDay(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }
    function addDays(date, n) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
    }
    function uid() {
        if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    }
    function parseDate(value) {
        if (value === null || value === undefined || value === '') return null;
        var d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }
    function formatBytes(bytes) {
        if (!bytes) return '0 KB';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    var TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    var WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
    var MONTH_DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' });
    var LONG_DATE_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    function formatTime(value) {
        return TIME_FMT.format(value instanceof Date ? value : new Date(value))
            .replace(/\bAM\b/i, 'a.m.')
            .replace(/\bPM\b/i, 'p.m.');
    }
    function formatDate(value) {
        return LONG_DATE_FMT.format(value instanceof Date ? value : new Date(value));
    }

    /* ------------------------------------------------------------- dom refs */

    var el = {};
    function cacheDom() {
        [
            'today-weekday', 'today-date', 'today-year', 'today-time',
            'keep-button', 'keep-label', 'cancel-edit', 'editor-status',
            'save-button', 'open-button', 'media-button', 'download-button',
            'focus-button', 'markdown-button', 'all-entries',
            'open-input', 'media-upload', 'editor',
            'days', 'recent-foot', 'output-card', 'output-heading', 'output',
            'edit-entry', 'delete-entry', 'toast', 'alert-bar', 'alert-text',
            'alert-action', 'alert-close', 'entries-dialog', 'entries-list',
            'entries-search', 'entries-close', 'image-dialog', 'focused-image',
            'image-close', 'theme-toggle'
        ].forEach(function (id) {
            el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
        });
    }

    /* ---------------------------------------------------------------- state */

    var entries = [];
    var currentEntry = null;
    var editingId = null;
    var focusMode = false;
    var suppressDraft = false;
    var draftTimer = null;
    var deleteArmedUntil = 0;
    var toastTimer = null;
    var lastDayKey = '';
    var quill = null;

    /* -------------------------------------------------------------- storage */

    function readEntries() {
        try {
            var raw = localStorage.getItem(KEY_ENTRIES);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
        } catch (err) {
            console.warn('Memory Prism: could not read saved entries.', err);
            return [];
        }
    }

    function isEntry(value) {
        return !!value && typeof value === 'object' &&
            typeof value.id === 'string' && typeof value.date === 'string' && typeof value.text === 'string' &&
            !isNaN(new Date(value.date).getTime());
    }

    function sortEntries() {
        entries.sort(function (a, b) { return Date.parse(b.date) - Date.parse(a.date); });
    }

    function persistEntries() {
        try {
            localStorage.setItem(KEY_ENTRIES, JSON.stringify(entries));
            return true;
        } catch (err) {
            console.warn('Memory Prism: could not store entries.', err);
            return false;
        }
    }

    function entryStoreSize() {
        try { return new Blob([JSON.stringify(entries)]).size; } catch (err) { return 0; }
    }

    function saveDraft() {
        try {
            localStorage.setItem(KEY_DRAFT, JSON.stringify({
                text: quill.root.innerHTML,
                at: new Date().toISOString()
            }));
            return true;
        } catch (err) {
            return false;
        }
    }

    function readDraft() {
        try {
            var raw = localStorage.getItem(KEY_DRAFT);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed.text === 'string' ? parsed : null;
        } catch (err) {
            return null;
        }
    }

    function clearDraft() {
        try { localStorage.removeItem(KEY_DRAFT); } catch (err) { /* ignore */ }
    }

    /* ----------------------------------------------------------- sanitising */

    var PURIFY_CONFIG = {
        ADD_TAGS: ['iframe', 'video', 'audio', 'source'],
        ADD_ATTR: ['controls', 'preload', 'playsinline', 'allowfullscreen', 'frameborder', 'type'],
        FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'button', 'select', 'meta', 'link'],
        FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus']
    };

    function sanitize(html) {
        var source = String(html === null || html === undefined ? '' : html);
        if (window.DOMPurify) return window.DOMPurify.sanitize(source, PURIFY_CONFIG);
        // Without the sanitizer, fall back to text so nothing executable survives.
        var div = document.createElement('div');
        div.textContent = source;
        return div.innerHTML;
    }

    function htmlToText(html) {
        var div = document.createElement('div');
        div.innerHTML = String(html || '');
        $$('img, video, audio, iframe', div).forEach(function (node) { node.remove(); });
        return div.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function isBlankHtml(html) {
        var div = document.createElement('div');
        div.innerHTML = String(html || '');
        if (div.querySelector('img, video, audio, iframe')) return false;
        return !div.textContent.replace(/\u00a0/g, ' ').trim();
    }

    /* -------------------------------------------------------------- feedback */

    function toast(message, options) {
        var opts = options || {};
        el.toast.textContent = '';
        var span = document.createElement('span');
        span.textContent = message;
        el.toast.appendChild(span);

        if (opts.action && typeof opts.action.run === 'function') {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'toast-action';
            button.textContent = opts.action.label;
            button.addEventListener('click', function () {
                el.toast.classList.remove('is-visible');
                clearTimeout(toastTimer);
                opts.action.run();
            });
            el.toast.appendChild(button);
        }

        el.toast.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.classList.remove('is-visible');
        }, opts.duration || 6000);
    }

    function showAlert(text, actionLabel, onAction) {
        el.alertText.textContent = text;
        if (actionLabel && typeof onAction === 'function') {
            el.alertAction.hidden = false;
            el.alertAction.textContent = actionLabel;
            el.alertAction.onclick = function () { onAction(); hideAlert(); };
        } else {
            el.alertAction.hidden = true;
            el.alertAction.onclick = null;
        }
        el.alertBar.hidden = false;
    }

    function hideAlert() {
        el.alertBar.hidden = true;
    }

    function storageFullAlert() {
        showAlert(
            'This browser cannot store more entries. Download a backup, then delete older entries to make room.',
            'Download backup',
            saveBackup
        );
    }

    function setStatus(text, warn) {
        el.editorStatus.textContent = text;
        el.editorStatus.classList.toggle('is-warn', !!warn);
    }

    /* ------------------------------------------------------------ date card */

    function renderDate() {
        var now = new Date();
        el.todayWeekday.textContent = WEEKDAY_FMT.format(now);
        el.todayDate.textContent = MONTH_DAY_FMT.format(now);
        el.todayYear.textContent = String(now.getFullYear());
        el.todayTime.textContent = formatTime(now);
        lastDayKey = dayKey(now);
    }

    function tick() {
        var now = new Date();
        el.todayTime.textContent = formatTime(now);
        if (dayKey(now) !== lastDayKey) {
            renderDate();
            renderRecent();
        }
    }

    /* ----------------------------------------------------------- recent grid */

    function renderRecent() {
        var today = startOfDay(new Date());
        var byDay = {};
        entries.forEach(function (entry) {
            var d = new Date(entry.date);
            var key = dayKey(d);
            if (!byDay[key]) byDay[key] = entry;
        });

        el.days.textContent = '';
        for (var i = 13; i >= 0; i--) {
            var date = addDays(today, -i);
            var key = dayKey(date);
            var entry = byDay[key];
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'day';
            button.textContent = String(date.getDate());

            var label = formatDate(date);
            if (entry) {
                button.classList.add('has');
                button.dataset.entryId = entry.id;
                button.title = label + ' — kept ' + formatTime(entry.date);
            } else {
                button.disabled = true;
                button.title = label + ' — no entry';
            }
            if (i === 0) button.classList.add('today');
            button.setAttribute('aria-label', button.title);
            el.days.appendChild(button);
        }

        var size = entryStoreSize();
        el.recentFoot.textContent = entries.length
            ? entries.length + (entries.length === 1 ? ' entry kept' : ' entries kept') + ' · ' + formatBytes(size) + ' stored'
            : 'Nothing kept yet. Your first entry will appear here.';
    }

    /* --------------------------------------------------------------- output */

    function renderOutput(entry) {
        currentEntry = entry || null;

        if (!currentEntry) {
            el.outputCard.hidden = true;
            el.output.textContent = '';
            el.outputHeading.textContent = '';
            return;
        }

        el.outputCard.hidden = false;
        el.outputHeading.textContent = formatDate(currentEntry.date) + ' · ' + formatTime(currentEntry.date);
        el.output.innerHTML = sanitize(currentEntry.text);
        el.deleteEntry.textContent = 'Delete';
        deleteArmedUntil = 0;
        refreshFocusableImages();
    }

    // With focus mode on, images become reachable and activatable by keyboard.
    function refreshFocusableImages() {
        $$('img', el.output).forEach(function (img) {
            if (focusMode) {
                img.tabIndex = 0;
                img.setAttribute('role', 'button');
                img.setAttribute('aria-label', 'Enlarge image');
            } else {
                img.removeAttribute('tabindex');
                img.removeAttribute('role');
                img.removeAttribute('aria-label');
            }
        });
    }

    function selectEntry(id) {
        var entry = entries.find(function (item) { return item.id === id; });
        if (!entry) { toast('That entry could not be found.'); return; }
        renderOutput(entry);
        el.outputCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderListAndNewest() {
        sortEntries();
        renderRecent();
        renderOutput(entries[0] || null);
    }

    /* ---------------------------------------------------------------- editor */

    function setEditorHtml(html) {
        suppressDraft = true;
        try {
            var delta = quill.clipboard.convert(String(html || ''));
            quill.setContents(delta, 'silent');
        } catch (err) {
            console.warn('Memory Prism: could not load entry into the editor.', err);
            quill.setText(htmlToText(html), 'silent');
        }
        suppressDraft = false;
    }

    function clearEditor() {
        suppressDraft = true;
        quill.setContents([], 'silent');
        suppressDraft = false;
        clearDraft();
    }

    function setEditing(id) {
        editingId = id || null;
        var editing = !!editingId;
        el.keepLabel.textContent = editing ? 'Update entry' : 'Keep this entry';
        el.cancelEdit.hidden = !editing;
    }

    /* ------------------------------------------------------------- keep flow */

    function keepEntry() {
        var html = quill.root.innerHTML;

        if (isBlankHtml(html)) {
            toast('Nothing to keep yet — write something first.');
            quill.focus();
            return;
        }

        var now = new Date();

        if (editingId) {
            var existing = entries.find(function (item) { return item.id === editingId; });
            if (existing) {
                var before = { text: existing.text, updated: existing.updated, revisions: existing.revisions };
                existing.text = html;
                existing.updated = now.toISOString();
                existing.revisions = (existing.revisions || 1) + 1;
                if (!persistEntries()) {
                    existing.text = before.text;
                    existing.updated = before.updated;
                    existing.revisions = before.revisions;
                    storageFullAlert();
                    return;
                }
                renderOutput(existing);
                renderRecent();
                setEditing(null);
                clearEditor();
                setStatus('Updated ' + formatTime(existing.date));
                toast('Entry updated.', {
                    action: {
                        label: 'Undo',
                        run: function () {
                            existing.text = before.text;
                            existing.updated = before.updated;
                            existing.revisions = before.revisions;
                            persistEntries();
                            renderOutput(existing);
                            renderRecent();
                            setEditorHtml(before.text);
                            setStatus('Change undone');
                        }
                    }
                });
                return;
            }
            setEditing(null);
        }

        var newest = entries[0];
        if (newest && newest.text === html && dayKey(new Date(newest.date)) === dayKey(now)) {
            toast('That entry is already kept.');
            return;
        }

        var record = {
            id: uid(),
            date: now.toISOString(),
            created: now.toISOString(),
            updated: now.toISOString(),
            text: html
        };

        entries.unshift(record);
        sortEntries();

        if (!persistEntries()) {
            entries = entries.filter(function (item) { return item.id !== record.id; });
            storageFullAlert();
            return;
        }

        renderRecent();
        renderOutput(record);
        clearEditor();
        setEditing(null);
        setStatus('Kept ' + formatTime(record.date));
        quill.focus();
        toast('Kept ' + formatTime(record.date) + '.', {
            action: {
                label: 'Undo',
                run: function () {
                    entries = entries.filter(function (item) { return item.id !== record.id; });
                    persistEntries();
                    setEditorHtml(record.text);
                    renderListAndNewest();
                    setStatus('Entry removed');
                }
            }
        });
    }

    function startEditing(id) {
        var entry = entries.find(function (item) { return item.id === id; });
        if (!entry) return;
        // Never lose an unsaved draft by opening an older entry over it.
        if (!editingId && !isBlankHtml(quill.root.innerHTML)) saveDraft();
        setEditing(entry.id);
        setEditorHtml(entry.text);
        setStatus('Editing a kept entry');
        quill.focus();
        document.querySelector('.editor-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function cancelEditing() {
        setEditing(null);
        clearEditor();
        setStatus('Draft saves automatically');
        quill.focus();
    }

    function deleteEntry(id) {
        var index = entries.findIndex(function (item) { return item.id === id; });
        if (index === -1) return;
        var removed = entries[index];
        entries.splice(index, 1);

        if (!persistEntries()) {
            entries.splice(index, 0, removed);
            storageFullAlert();
            return;
        }

        if (editingId === id) setEditing(null);
        renderListAndNewest();
        toast('Entry deleted.', {
            duration: 8000,
            action: {
                label: 'Undo',
                run: function () {
                    entries.push(removed);
                    sortEntries();
                    persistEntries();
                    renderRecent();
                    renderOutput(removed);
                    toast('Entry restored.');
                }
            }
        });
    }

    /* ------------------------------------------------------------ draft flow */

    function scheduleDraftSave() {
        if (suppressDraft) return;
        clearTimeout(draftTimer);
        draftTimer = setTimeout(function () {
            draftTimer = null;
            if (saveDraft()) {
                if (!el.editorStatus.classList.contains('is-warn')) {
                    setStatus('Draft saved ' + formatTime(new Date()));
                }
            } else {
                setStatus('Draft not saved — browser storage is full', true);
            }
        }, 600);
    }

    function restoreDraft() {
        var draft = readDraft();
        if (draft && draft.text && !isBlankHtml(draft.text)) {
            setEditorHtml(draft.text);
            var at = parseDate(draft.at);
            setStatus(at ? 'Draft restored · ' + formatTime(at) : 'Draft restored');
        } else {
            setStatus(entries.length ? 'Nothing kept yet' : 'Draft saves automatically');
        }
    }

    /* ------------------------------------------------------------ backup i/o */

    function downloadBlob(blob, name) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function downloadText(text, name, type) {
        downloadBlob(new Blob([text], { type: type || 'text/plain;charset=utf-8' }), name);
    }

    function downloadUrl(url, name) {
        var link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function saveBackup() {
        if (!entries.length) {
            toast('Nothing to save yet — keep an entry first.');
            return;
        }
        var payload = {
            app: 'memory-prism',
            version: 2,
            exportedAt: new Date().toISOString(),
            entries: entries
        };
        downloadBlob(
            new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
            'memory-prism-' + dayKey(new Date()) + '.json'
        );
        toast('Saved ' + entries.length + (entries.length === 1 ? ' entry' : ' entries') + ' to a backup file.');
    }

    function normalizeImport(data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.entries)) return data.entries;
        if (data && typeof data.text === 'string') return [data];
        return [];
    }

    function importEntries(data) {
        var list = normalizeImport(data);
        var addedIds = [];
        if (!list.length) return addedIds;

        var before = entries.slice();

        list.forEach(function (raw) {
            if (!raw || typeof raw !== 'object') return;
            var html = sanitize(typeof raw.text === 'string' ? raw.text : '');
            if (isBlankHtml(html)) return;

            var date = parseDate(raw.date) || new Date();
            var id = typeof raw.id === 'string' && raw.id && !entries.some(function (e) { return e.id === raw.id; })
                ? raw.id
                : uid();

            entries.push({
                id: id,
                date: date.toISOString(),
                created: (parseDate(raw.created) || date).toISOString(),
                updated: (parseDate(raw.updated) || date).toISOString(),
                text: html
            });
            addedIds.push(id);
        });

        if (!addedIds.length) return addedIds;

        sortEntries();
        if (!persistEntries()) {
            entries = before;
            storageFullAlert();
            return [];
        }
        renderRecent();
        renderOutput(entries[0] || null);
        return addedIds;
    }

    function handleFile(file) {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
            toast('That file is too large to import.');
            return;
        }
        var reader = new FileReader();
        reader.onerror = function () { toast('Could not read that file.'); };
        reader.onload = function () {
            var data;
            try {
                data = JSON.parse(String(reader.result));
            } catch (err) {
                toast('That file is not a Memory Prism backup. Nothing was changed.');
                return;
            }
            var addedIds = importEntries(data);
            if (!addedIds.length) {
                toast('No entries found in that file.');
                return;
            }
            toast('Imported ' + addedIds.length + (addedIds.length === 1 ? ' entry.' : ' entries.'), {
                action: {
                    label: 'Undo',
                    run: function () {
                        entries = entries.filter(function (entry) { return addedIds.indexOf(entry.id) === -1; });
                        persistEntries();
                        renderListAndNewest();
                    }
                }
            });
        };
        reader.readAsText(file);
    }

    /* ------------------------------------------------------------- markdown */

    function mdInline(node) {
        var out = '';
        node.childNodes.forEach(function (child) {
            if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, ' '); return; }
            if (child.nodeType !== 1) return;
            var tag = child.tagName.toLowerCase();
            if (tag === 'strong' || tag === 'b') out += '**' + mdInline(child) + '**';
            else if (tag === 'em' || tag === 'i') out += '*' + mdInline(child) + '*';
            else if (tag === 'u') out += '<u>' + mdInline(child) + '</u>';
            else if (tag === 's' || tag === 'strike' || tag === 'del') out += '~~' + mdInline(child) + '~~';
            else if (tag === 'a') out += '[' + mdInline(child) + '](' + (child.getAttribute('href') || '') + ')';
            else if (tag === 'img') out += '![' + (child.getAttribute('alt') || 'image') + '](' + (child.getAttribute('src') || '') + ')';
            else if (tag === 'br') out += '\n';
            else if (tag === 'code') out += '`' + child.textContent + '`';
            else out += mdInline(child);
        });
        return out;
    }

    function htmlToMarkdown(html) {
        var root = document.createElement('div');
        root.innerHTML = String(html || '');
        var blocks = [];

        root.childNodes.forEach(function (node) {
            if (node.nodeType === 3) {
                var text = node.nodeValue.trim();
                if (text) blocks.push(text);
                return;
            }
            if (node.nodeType !== 1) return;
            var tag = node.tagName.toLowerCase();

            if (/^h[1-6]$/.test(tag)) {
                blocks.push('#'.repeat(Number(tag[1])) + ' ' + mdInline(node).trim());
            } else if (tag === 'p') {
                var line = mdInline(node).trim();
                if (line) blocks.push(line);
            } else if (tag === 'ul' || tag === 'ol') {
                $$('li', node).forEach(function (li, index) {
                    blocks.push((tag === 'ol' ? (index + 1) + '. ' : '- ') + mdInline(li).trim());
                });
            } else if (tag === 'blockquote') {
                blocks.push(mdInline(node).trim().split('\n').map(function (l) { return '> ' + l; }).join('\n'));
            } else if (tag === 'pre') {
                blocks.push('```\n' + node.textContent.replace(/\n$/, '') + '\n```');
            } else if (tag === 'hr') {
                blocks.push('---');
            } else if (tag === 'audio') {
                blocks.push('_[audio attachment]_');
            } else if (tag === 'video') {
                blocks.push('_[video attachment]_');
            } else if (tag === 'iframe') {
                blocks.push('[' + (node.getAttribute('src') || 'embedded video') + '](' + (node.getAttribute('src') || '') + ')');
            } else if (tag === 'img') {
                blocks.push('![' + (node.getAttribute('alt') || 'image') + '](' + (node.getAttribute('src') || '') + ')');
            } else {
                var fallback = mdInline(node).trim();
                if (fallback) blocks.push(fallback);
            }
        });

        return blocks.join('\n\n');
    }

    function exportMarkdown() {
        if (currentEntry) {
            var body = htmlToMarkdown(currentEntry.text);
            var header = '# ' + formatDate(currentEntry.date) + '\n\n_' + formatTime(currentEntry.date) + '_\n\n';
            downloadText(header + body + '\n', 'memory-' + dayKey(new Date(currentEntry.date)) + '.md', 'text/markdown;charset=utf-8');
            toast('Exported that entry as Markdown.');
            return;
        }
        if (isBlankHtml(quill.root.innerHTML)) {
            toast('Nothing to export yet.');
            return;
        }
        downloadText(htmlToMarkdown(quill.root.innerHTML) + '\n', 'memory-draft-' + dayKey(new Date()) + '.md', 'text/markdown;charset=utf-8');
        toast('Exported the draft as Markdown.');
    }

    /* ---------------------------------------------------------------- media */

    var EXT_TO_TYPE = {
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
        aac: 'audio/aac', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
        mov: 'video/quicktime', m4v: 'video/mp4', png: 'image/png', jpg: 'image/jpeg',
        jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
        svg: 'image/svg+xml'
    };
    var TYPE_TO_EXT = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4',
        'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
        'audio/flac': 'flac'
    };

    function mediaTypeOf(file) {
        if (file.type && file.type !== 'application/octet-stream') return file.type;
        var ext = (file.name.split('.').pop() || '').toLowerCase();
        return EXT_TO_TYPE[ext] || '';
    }

    function extFromDataUrl(url, fallback) {
        var match = /^data:([^;,]+)/i.exec(url || '');
        if (match && TYPE_TO_EXT[match[1].toLowerCase()]) return TYPE_TO_EXT[match[1].toLowerCase()];
        var ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url || '');
        if (ext) return ext[1].toLowerCase();
        return fallback;
    }

    function readAsDataURL(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result)); };
            reader.onerror = function () { reject(reader.error || new Error('read failed')); };
            reader.readAsDataURL(file);
        });
    }

    function shrinkImage(file) {
        if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
        return createImageBitmap(file).then(function (bitmap) {
            var longest = Math.max(bitmap.width, bitmap.height);
            var scale = Math.min(1, IMAGE_MAX_EDGE / longest);
            var width = Math.max(1, Math.round(bitmap.width * scale));
            var height = Math.max(1, Math.round(bitmap.height * scale));
            var canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            var context = canvas.getContext('2d');
            if (!context) return null;
            context.drawImage(bitmap, 0, 0, width, height);
            if (typeof bitmap.close === 'function') bitmap.close();
            return canvas.toDataURL('image/jpeg', 0.86);
        }).catch(function () { return null; });
    }

    function insertMedia(file) {
        var type = mediaTypeOf(file);
        if (!/^(image|video|audio)\//.test(type)) {
            toast('Cannot add ' + file.name + ' — unsupported file type.');
            return Promise.resolve();
        }

        var prepare;
        if (type.indexOf('image/') === 0 && file.size > IMAGE_SHRINK_ABOVE) {
            prepare = shrinkImage(file).then(function (shrunk) {
                return shrunk || readAsDataURL(file);
            });
        } else {
            prepare = readAsDataURL(file);
        }

        return prepare.then(function (dataUrl) {
            if (dataUrl.length > MAX_MEDIA_BYTES * 1.4) {
                toast(file.name + ' is too large to keep here (' + formatBytes(file.size) + ').');
                return;
            }
            var range = quill.getSelection(true) || { index: quill.getLength() };
            var at = range.index;

            if (type.indexOf('image/') === 0) {
                quill.insertEmbed(at, 'image', dataUrl, 'user');
            } else if (type.indexOf('video/') === 0) {
                quill.insertEmbed(at, 'localVideo', { url: dataUrl, type: type }, 'user');
            } else {
                quill.insertEmbed(at, 'audio', { url: dataUrl, type: type }, 'user');
            }

            quill.setSelection(at + 1, 0, 'silent');
        }).catch(function (err) {
            console.warn('Memory Prism: media insert failed.', err);
            toast('Could not add that file.');
        });
    }

    function downloadMedia() {
        if (!currentEntry) {
            toast('Open a kept entry first, then download its media.');
            return;
        }
        var items = [];
        $$('img', el.output).forEach(function (img, index) {
            items.push({ url: img.currentSrc || img.src, name: 'image-' + (index + 1) + '.' + extFromDataUrl(img.src, 'png') });
        });
        $$('video', el.output).forEach(function (video, index) {
            var source = video.querySelector('source');
            var url = video.currentSrc || video.src || (source && source.src);
            if (url) items.push({ url: url, name: 'video-' + (index + 1) + '.' + extFromDataUrl(url, 'mp4') });
        });
        $$('audio', el.output).forEach(function (audio, index) {
            var source = audio.querySelector('source');
            var url = audio.currentSrc || audio.src || (source && source.src);
            if (url) items.push({ url: url, name: 'audio-' + (index + 1) + '.' + extFromDataUrl(url, 'mp3') });
        });

        if (!items.length) {
            toast('This entry has no media to download.');
            return;
        }
        items.forEach(function (item, index) {
            setTimeout(function () { downloadUrl(item.url, item.name); }, index * 300);
        });
        toast(items.length === 1 ? 'Downloading 1 attachment.' : 'Downloading ' + items.length + ' attachments.');
    }

    /* --------------------------------------------------------------- dialogs */

    function openEntriesDialog() {
        renderEntryList(el.entriesSearch.value);
        el.entriesDialog.showModal();
        el.entriesSearch.focus();
    }

    function renderEntryList(query) {
        var needle = String(query || '').trim().toLowerCase();
        var list = entries.filter(function (entry) {
            if (!needle) return true;
            return (htmlToText(entry.text) + ' ' + formatDate(entry.date)).toLowerCase().indexOf(needle) !== -1;
        });

        el.entriesList.textContent = '';
        if (!list.length) {
            var empty = document.createElement('p');
            empty.className = 'dialog-empty';
            empty.textContent = entries.length ? 'No entries match that search.' : 'No entries yet.';
            el.entriesList.appendChild(empty);
            return;
        }

        list.forEach(function (entry) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'entry-row';
            row.dataset.entryId = entry.id;

            var date = document.createElement('span');
            date.className = 'entry-row-date';
            date.textContent = formatDate(entry.date) + ' · ' + formatTime(entry.date);

            var text = document.createElement('span');
            text.className = 'entry-row-text';
            text.textContent = htmlToText(entry.text).slice(0, 120) || '(media only)';

            row.appendChild(date);
            row.appendChild(text);
            el.entriesList.appendChild(row);
        });
    }

    function openImage(src, alt) {
        el.focusedImage.src = src;
        el.focusedImage.alt = alt || 'Image from this entry';
        el.imageDialog.showModal();
    }

    /* ---------------------------------------------------------------- theme */

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function applyTheme(theme, persist) {
        document.documentElement.setAttribute('data-theme', theme);
        var use = el.themeToggle.querySelector('use');
        if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
        el.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
        el.themeToggle.setAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'dark' ? '#141413' : '#f0efeb');
        if (persist) {
            try { localStorage.setItem(KEY_THEME, theme); } catch (err) { /* ignore */ }
        }
    }

    function initTheme() {
        var stored = null;
        try { stored = localStorage.getItem(KEY_THEME); } catch (err) { /* ignore */ }
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyTheme(stored === 'dark' || stored === 'light' ? stored : (prefersDark ? 'dark' : 'light'), false);

        if (window.matchMedia) {
            var query = window.matchMedia('(prefers-color-scheme: dark)');
            var onChange = function (event) {
                var manual = null;
                try { manual = localStorage.getItem(KEY_THEME); } catch (err) { /* ignore */ }
                if (!manual) applyTheme(event.matches ? 'dark' : 'light', false);
            };
            if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
        }
    }

    /* ----------------------------------------------------------- focus mode */

    function setFocusMode(value) {
        focusMode = !!value;
        el.focusButton.setAttribute('aria-pressed', String(focusMode));
        document.body.classList.toggle('focus-mode', focusMode);
        refreshFocusableImages();
        try { localStorage.setItem(KEY_FOCUS, focusMode ? '1' : '0'); } catch (err) { /* ignore */ }
        toast(focusMode ? 'Focus images on — click or tab to any image to enlarge it.' : 'Focus images off.');
    }

    /* ----------------------------------------------------------------- logo */

    function initLogo() {
        var logo = $('.logo-text');
        if (!logo) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        var text = logo.textContent;
        var letters = null;
        var timers = [];
        var running = false;
        var hoverTimer = null;
        var DURATION = 9000;

        function split() {
            if (letters) return;
            logo.textContent = '';
            letters = [];
            for (var i = 0; i < text.length; i++) {
                var span = document.createElement('span');
                span.textContent = text[i] === ' ' ? '\u00A0' : text[i];
                logo.appendChild(span);
                letters.push(span);
            }
        }

        function stop() {
            if (!running) return;
            running = false;
            timers.forEach(clearTimeout);
            timers = [];
            if (!letters) return;
            letters.forEach(function (span) {
                span.style.transition = 'transform .7s ease';
                span.style.transform = 'translate(0, 0)';
                span.style.willChange = 'auto';
            });
        }

        function floatOne(span, baseLeft, baseTop, box, until) {
            if (!running || Date.now() >= until) return;
            var rect = span.getBoundingClientRect();
            var targetX = Math.random() * Math.max(0, box.width - rect.width) - baseLeft;
            var targetY = Math.random() * Math.max(0, box.height - rect.height) - baseTop;
            var duration = 0.9 + Math.random() * 0.7;
            span.style.transition = 'transform ' + duration + 's ease-in-out';
            span.style.transform = 'translate(' + targetX + 'px, ' + targetY + 'px)';
            timers.push(setTimeout(function () {
                floatOne(span, baseLeft, baseTop, box, until);
            }, duration * 1000));
        }

        function start() {
            if (running) return;
            split();
            var header = $('.app-header');
            var box = header.getBoundingClientRect();
            var until = Date.now() + DURATION;
            running = true;
            letters.forEach(function (span) {
                var rect = span.getBoundingClientRect();
                span.style.willChange = 'transform';
                floatOne(span, rect.left - box.left, rect.top - box.top, box, until);
            });
            timers.push(setTimeout(stop, DURATION));
        }

        logo.addEventListener('mouseenter', function () {
            if (running) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(start, 2500);
        });
        logo.addEventListener('mouseleave', function () {
            clearTimeout(hoverTimer);
        });

        var header = $('.app-header');
        header.addEventListener('mouseleave', stop);
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') stop();
        });
    }

    /* ------------------------------------------------------------- quill set */

    function initQuill() {
        var BlockEmbed = Quill.import('blots/block/embed');

        class AudioBlot extends BlockEmbed {
            static create(value) {
                var node = super.create();
                var media = typeof value === 'string' ? { url: value } : (value || {});
                node.setAttribute('controls', '');
                node.setAttribute('preload', 'metadata');
                if (media.url) node.setAttribute('src', media.url);
                if (media.type) node.setAttribute('type', media.type);
                return node;
            }

            static value(node) {
                return { url: node.getAttribute('src'), type: node.getAttribute('type') };
            }
        }
        AudioBlot.blotName = 'audio';
        AudioBlot.tagName = 'audio';
        Quill.register(AudioBlot);

        // Registered as `localVideo` rather than `video` so Quill's built-in
        // iframe embed (the toolbar's link-to-video button) keeps working.
        class VideoBlot extends BlockEmbed {
            static create(value) {
                var node = super.create();
                var media = typeof value === 'string' ? { url: value } : (value || {});
                node.setAttribute('controls', '');
                node.setAttribute('preload', 'metadata');
                node.setAttribute('playsinline', '');
                if (media.url) node.setAttribute('src', media.url);
                if (media.type) node.setAttribute('type', media.type);
                return node;
            }

            static value(node) {
                return { url: node.getAttribute('src'), type: node.getAttribute('type') };
            }
        }
        VideoBlot.blotName = 'localVideo';
        VideoBlot.tagName = 'video';
        Quill.register(VideoBlot);

        quill = new Quill('#editor', {
            theme: 'snow',
            placeholder: 'What happened today?',
            modules: {
                toolbar: [
                    [{ header: [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    ['image', 'video'],
                    ['code-block'],
                    ['clean']
                ]
            }
        });

        quill.root.setAttribute('role', 'textbox');
        quill.root.setAttribute('aria-multiline', 'true');
        quill.root.setAttribute('aria-label', 'Write today\'s memory');

        var labels = {
            'ql-bold': 'Bold', 'ql-italic': 'Italic', 'ql-underline': 'Underline',
            'ql-strike': 'Strikethrough', 'ql-image': 'Insert an image',
            'ql-video': 'Insert a video link', 'ql-code-block': 'Code block',
            'ql-clean': 'Clear formatting', 'ql-header': 'Text style'
        };
        $$('.ql-toolbar button, .ql-toolbar .ql-picker-label').forEach(function (node) {
            var key = Object.keys(labels).find(function (name) { return node.classList.contains(name); });
            if (!key) return;
            node.setAttribute('aria-label', labels[key]);
            node.setAttribute('title', labels[key]);
        });

        quill.on('text-change', scheduleDraftSave);
        quill.focus();
    }

    /* ---------------------------------------------------------------- wiring */

    function wire() {
        el.keepButton.addEventListener('click', keepEntry);

        el.saveButton.addEventListener('click', saveBackup);
        el.openButton.addEventListener('click', function () { el.openInput.click(); });
        el.openInput.addEventListener('change', function (event) {
            var file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            handleFile(file);
        });

        el.mediaButton.addEventListener('click', function () { el.mediaUpload.click(); });
        el.mediaUpload.addEventListener('change', function (event) {
            var files = Array.prototype.slice.call(event.target.files || []);
            event.target.value = '';
            if (!files.length) return;
            files.reduce(function (chain, file) {
                return chain.then(function () { return insertMedia(file); });
            }, Promise.resolve());
        });

        el.downloadButton.addEventListener('click', downloadMedia);
        el.markdownButton.addEventListener('click', exportMarkdown);
        el.focusButton.addEventListener('click', function () { setFocusMode(!focusMode); });

        el.allEntries.addEventListener('click', openEntriesDialog);
        el.entriesClose.addEventListener('click', function () { el.entriesDialog.close(); });
        el.entriesSearch.addEventListener('input', function () { renderEntryList(el.entriesSearch.value); });
        el.entriesList.addEventListener('click', function (event) {
            var row = event.target.closest('.entry-row');
            if (!row) return;
            selectEntry(row.dataset.entryId);
            el.entriesDialog.close();
        });
        el.entriesDialog.addEventListener('click', function (event) {
            if (event.target === el.entriesDialog) el.entriesDialog.close();
        });

        el.days.addEventListener('click', function (event) {
            var day = event.target.closest('.day');
            if (!day || !day.dataset.entryId) return;
            selectEntry(day.dataset.entryId);
        });

        el.editEntry.addEventListener('click', function () {
            if (currentEntry) startEditing(currentEntry.id);
        });
        el.cancelEdit.addEventListener('click', cancelEditing);

        el.deleteEntry.addEventListener('click', function () {
            if (!currentEntry) return;
            if (Date.now() > deleteArmedUntil) {
                deleteArmedUntil = Date.now() + 4000;
                el.deleteEntry.textContent = 'Delete?';
                toast('Click Delete again to confirm.');
                setTimeout(function () {
                    deleteArmedUntil = 0;
                    el.deleteEntry.textContent = 'Delete';
                }, 4000);
                return;
            }
            deleteArmedUntil = 0;
            deleteEntry(currentEntry.id);
        });

        el.alertClose.addEventListener('click', hideAlert);

        el.themeToggle.addEventListener('click', function () {
            applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
        });

        el.imageClose.addEventListener('click', function () { el.imageDialog.close(); });
        el.imageDialog.addEventListener('click', function (event) {
            if (event.target === el.imageDialog) el.imageDialog.close();
        });

        document.addEventListener('click', function (event) {
            if (!focusMode) return;
            var image = event.target.closest('#output img, .ql-editor img');
            if (!image) return;
            event.preventDefault();
            openImage(image.currentSrc || image.src, image.alt);
        });

        el.output.addEventListener('keydown', function (event) {
            if (!focusMode) return;
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            var image = event.target.closest('img');
            if (!image) return;
            event.preventDefault();
            openImage(image.currentSrc || image.src, image.alt);
        });

        document.addEventListener('keydown', function (event) {
            var mod = event.ctrlKey || event.metaKey;
            if (!mod) return;
            if (event.key === 'Enter') {
                event.preventDefault();
                keepEntry();
            } else if (event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveBackup();
            } else if (event.key.toLowerCase() === 'o') {
                event.preventDefault();
                el.openInput.click();
            }
        });
    }

    /* ------------------------------------------------------------------ init */

    function init() {
        cacheDom();
        initTheme();
        initQuill();

        entries = readEntries();
        sortEntries();

        focusMode = (function () {
            try { return localStorage.getItem(KEY_FOCUS) === '1'; } catch (err) { return false; }
        })();
        el.focusButton.setAttribute('aria-pressed', String(focusMode));
        document.body.classList.toggle('focus-mode', focusMode);

        renderDate();
        renderRecent();
        renderOutput(entries[0] || null);
        restoreDraft();

        wire();
        initLogo();
        setInterval(tick, 30000);

        // Leaving the page (e.g. the "v1" switch): write any draft save still pending.
        window.addEventListener('pagehide', function () {
            if (draftTimer) {
                clearTimeout(draftTimer);
                draftTimer = null;
                saveDraft();
            }
        });

        // Debug/test handle. Safe to remove; nothing in the app depends on it.
        window.MemoryPrism = {
            quill: quill,
            keep: keepEntry,
            selectEntry: selectEntry,
            saveBackup: saveBackup,
            importFile: handleFile,
            getEntries: function () { return entries.slice(); },
            getCurrent: function () { return currentEntry; }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
