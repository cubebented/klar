    (() => {
      'use strict';

      // API calls go through Vercel Edge Functions so the keys never ship to the browser.
      const API_URL = '/api/generate';
      const MODEL = 'deepseek-chat';
      const STORAGE_KEY = 'deutschify:count';
      const STATS_KEY = 'deutschify:stats';
      const PROFILES_KEY = 'deutschify:profiles';
      const ACTIVE_PROFILE_KEY = 'deutschify:active-profile';

      const MODE_LABELS = {
        daily: 'Daily Talk',
        school: 'School question',
        story: 'Short story',
        chat: 'Chat back',
      };

      const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
      const LENGTHS = ['short', 'medium', 'long'];
      const REGISTERS = ['casual', 'formal'];

      // ONLY native German voices. Inworld's catalog has 135 voices but exactly 2
      // declare `languages: ['de']` — Johanna and Josef. Everyone else is English /
      // French / Chinese etc. native and sounds wrong reading German, even via the
      // multilingual model. This is a German learning app, so we ship only de speakers.
      const ALWAYS_INCLUDE_VOICES = [
        { id: 'Johanna', label: 'Johanna — German female' },
        { id: 'Josef',   label: 'Josef — German male' },
      ];
      let GERMAN_VOICES = [...ALWAYS_INCLUDE_VOICES];
      let DEFAULT_VOICE = 'Johanna';

      const RANKS = [
        { name: 'Beginner',     min: 0 },
        { name: 'Novice',       min: 150 },
        { name: 'Learner',      min: 350 },
        { name: 'Apprentice',   min: 600 },
        { name: 'Intermediate', min: 900 },
        { name: 'Advanced',     min: 1300 },
        { name: 'Proficient',   min: 1750 },
        { name: 'Expert',       min: 2300 },
        { name: 'Fluent',       min: 3000 },
      ];

      const LEVEL_BONUS = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4 };

      // XP needed to "max" each level (then prestige unlocks)
      const LEVEL_XP_MAX = {
        A1: 400, A2: 700, B1: 1100, B2: 1600, C1: 2200,
      };

      // Sub-difficulty progression within a level
      const SUBLEVELS = [
        { key: 'easy',   name: 'Easy',   from: 0.00, to: 0.25, mult: 1.0, timed: false },
        { key: 'medium', name: 'Medium', from: 0.25, to: 0.50, mult: 1.5, timed: false },
        { key: 'hard',   name: 'Hard',   from: 0.50, to: 0.75, mult: 2.0, timed: false },
        { key: 'max',    name: 'Max',    from: 0.75, to: 1.00, mult: 2.5, timed: true  },
      ];

      const SUB_HINT = {
        easy:   'Lean toward the EASIER end of this level: shorter sentences, very common vocabulary, no surprises.',
        medium: 'Standard difficulty for this level.',
        hard:   'Lean toward the HARDER end of this level: more sophisticated vocabulary, longer sentences, less common topic.',
        max:    'Push the upper edge of this level: complex sentence structures and advanced vocabulary still appropriate, demanding topic.',
      };

      // Safe storage — sandboxed iframes/file:// can throw on access
      const safeStore = {
        get(k) {
          try { return window.localStorage && localStorage.getItem(k); }
          catch (_) { return null; }
        },
        set(k, v) {
          try { window.localStorage && localStorage.setItem(k, v); }
          catch (_) {}
        },
      };

      const MODES = ['daily', 'school', 'story', 'chat'];

      // Available "weak area" tags the user can pick in their profile.
      // Used to subtly bias generation toward grammar they want to practice.
      const WEAK_AREAS = [
        { id: 'cases',        label: 'Cases (Akk/Dat/Gen)' },
        { id: 'verbs',        label: 'Verb conjugation' },
        { id: 'word-order',   label: 'Word order' },
        { id: 'separable',    label: 'Separable verbs' },
        { id: 'prepositions', label: 'Prepositions' },
        { id: 'articles',     label: 'Articles (der/die/das)' },
        { id: 'modals',       label: 'Modal verbs' },
        { id: 'past',         label: 'Past tenses' },
        { id: 'subjunctive',  label: 'Konjunktiv II' },
        { id: 'vocab',        label: 'Vocabulary' },
        { id: 'listening',    label: 'Listening comprehension' },
      ];

      const state = {
        mode: 'daily',
        level: 'A2',
        length: LENGTHS.includes(safeStore.get('deutschify:length')) ? safeStore.get('deutschify:length') : 'medium',
        register: REGISTERS.includes(safeStore.get('deutschify:register')) ? safeStore.get('deutschify:register') : 'casual',
        voiceId: (function () {
          const saved = safeStore.get('deutschify:voice');
          // Anything not in the German-voice list (incl. old English picks like
          // Olivia, Sarah, Mia, Hugo, etc.) → migrate to Johanna.
          return GERMAN_VOICES.some((v) => v.id === saved) ? saved : DEFAULT_VOICE;
        })(),
        lang: safeStore.get('deutschify:lang') === 'en' ? 'en' : 'de',
        loading: false,
        hasGenerated: false,
        lastData: null,
        view: 'read',

        // persistent
        totalTexts: parseInt(safeStore.get(STORAGE_KEY) || '0', 10) || 0,
        daily: {},                        // { 'YYYY-MM-DD': { texts, xp } }
        streakCurrent: 0,
        streakLastDate: null,
        levelXp: { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 },
        levelPrestige: { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 },
        hoverWords: {},                   // { word: count } — internal, used for AI feedback only
        savedWords: {},                   // { lower-case-word: { original, trans, savedAt } }
        feedback: { sentence: '', generatedAt: 0 },

        // per-text session (not persisted)
        session: null,
      };

      loadStats();
      initProfiles();

      // ─────────────────────── PROFILES (family) ─────────────────────────
      // Each profile is its own learner: own level, saved words, daily streak,
      // PLUS personal context (age, hobbies, goals) that the AI uses to make
      // generated content actually relevant to that person.
      function generateProfileId() {
        return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      }
      function deepClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return o; } }

      function makeBlankProfile(name) {
        return {
          id: generateProfileId(),
          name: name || 'New member',
          age: '', occupation: '', hobbies: '', location: '', goals: '', weakAreas: [],
          level: 'A2', length: 'medium', register: 'casual', mode: 'daily', voiceId: DEFAULT_VOICE,
          totalTexts: 0, daily: {}, streakCurrent: 0, streakLastDate: null,
          levelXp: { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 },
          levelPrestige: { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 },
          hoverWords: {}, savedWords: {}, feedback: { sentence: '', generatedAt: 0 },
          createdAt: Date.now(),
        };
      }

      function snapshotStateAsProfile(id, name) {
        const blank = makeBlankProfile(name);
        return Object.assign(blank, {
          id, name: name || 'You',
          level: state.level, length: state.length, register: state.register,
          mode: state.mode, voiceId: state.voiceId,
          totalTexts: state.totalTexts || 0,
          daily: deepClone(state.daily || {}),
          streakCurrent: state.streakCurrent || 0,
          streakLastDate: state.streakLastDate || null,
          levelXp: deepClone(state.levelXp), levelPrestige: deepClone(state.levelPrestige),
          hoverWords: deepClone(state.hoverWords || {}),
          savedWords: deepClone(state.savedWords || {}),
          feedback: deepClone(state.feedback || { sentence: '', generatedAt: 0 }),
        });
      }

      function applyProfileToState(p) {
        if (!p) return;
        state.level = p.level || 'A2';
        state.length = p.length || 'medium';
        state.register = p.register || 'casual';
        state.mode = p.mode || 'daily';
        state.voiceId = p.voiceId || DEFAULT_VOICE;
        state.totalTexts = p.totalTexts || 0;
        state.daily = deepClone(p.daily || {});
        state.streakCurrent = p.streakCurrent || 0;
        state.streakLastDate = p.streakLastDate || null;
        state.levelXp = deepClone(p.levelXp || { A1:0,A2:0,B1:0,B2:0,C1:0 });
        state.levelPrestige = deepClone(p.levelPrestige || { A1:0,A2:0,B1:0,B2:0,C1:0 });
        state.hoverWords = deepClone(p.hoverWords || {});
        state.savedWords = deepClone(p.savedWords || {});
        state.feedback = deepClone(p.feedback || { sentence: '', generatedAt: 0 });
      }

      function syncStateToActiveProfile() {
        const p = state.profiles && state.profiles[state.activeProfileId];
        if (!p) return;
        Object.assign(p, {
          level: state.level, length: state.length, register: state.register,
          mode: state.mode, voiceId: state.voiceId,
          totalTexts: state.totalTexts,
          daily: state.daily,
          streakCurrent: state.streakCurrent, streakLastDate: state.streakLastDate,
          levelXp: state.levelXp, levelPrestige: state.levelPrestige,
          hoverWords: state.hoverWords, savedWords: state.savedWords,
          feedback: state.feedback,
        });
      }

      function persistProfiles() {
        syncStateToActiveProfile();
        safeStore.set(PROFILES_KEY, JSON.stringify(state.profiles));
        safeStore.set(ACTIVE_PROFILE_KEY, state.activeProfileId);
      }

      function getActiveProfile() {
        return (state.profiles || {})[state.activeProfileId] || null;
      }

      function initProfiles() {
        let profiles = null;
        try {
          const raw = safeStore.get(PROFILES_KEY);
          if (raw) profiles = JSON.parse(raw);
        } catch (_) {}

        state.profiles = profiles && typeof profiles === 'object' ? profiles : {};
        const ids = Object.keys(state.profiles);

        if (ids.length === 0) {
          // First-run / migration: snapshot anything loaded from old STATS_KEY
          const seed = snapshotStateAsProfile(generateProfileId(), 'You');
          state.profiles[seed.id] = seed;
          state.activeProfileId = seed.id;
          persistProfiles();
        } else {
          const savedActive = safeStore.get(ACTIVE_PROFILE_KEY);
          state.activeProfileId = state.profiles[savedActive] ? savedActive : ids[0];
          applyProfileToState(state.profiles[state.activeProfileId]);
        }
      }

      function switchProfile(id) {
        if (!state.profiles[id] || id === state.activeProfileId) return;
        persistProfiles();                            // commit current state to current profile
        state.activeProfileId = id;
        applyProfileToState(state.profiles[id]);
        safeStore.set(ACTIVE_PROFILE_KEY, id);
        if (typeof onActiveProfileChanged === 'function') onActiveProfileChanged();
      }

      function createProfileWithName(name) {
        const p = makeBlankProfile(name);
        state.profiles[p.id] = p;
        persistProfiles();
        return p.id;
      }

      function deleteProfile(id) {
        if (Object.keys(state.profiles).length <= 1) return; // can't delete last
        delete state.profiles[id];
        if (state.activeProfileId === id) {
          state.activeProfileId = Object.keys(state.profiles)[0];
          applyProfileToState(state.profiles[state.activeProfileId]);
          if (typeof onActiveProfileChanged === 'function') onActiveProfileChanged();
        }
        persistProfiles();
      }

      function loadStats() {
        try {
          const raw = safeStore.get(STATS_KEY);
          if (!raw) return;
          const data = JSON.parse(raw);
          state.totalTexts = +data.totalTexts || +data.count || state.totalTexts || 0;
          state.daily = data.daily || {};

          // strip old hover/word fields from daily entries; keep texts + xp
          for (const k of Object.keys(state.daily)) {
            const d = state.daily[k] || {};
            state.daily[k] = {
              texts: +d.texts || 0,
              xp: +d.xp || +d.elo || 0,
            };
          }

          state.streakCurrent = +data.streakCurrent || 0;
          state.streakLastDate = data.streakLastDate || null;

          if (data.levelXp) {
            for (const lvl of LEVELS) state.levelXp[lvl] = +data.levelXp[lvl] || 0;
          } else if (data.elo) {
            // migrate from old single-elo: cascade through levels A1→C1
            let remaining = +data.elo || 0;
            for (const lvl of LEVELS) {
              const cap = LEVEL_XP_MAX[lvl];
              const give = Math.min(remaining, cap);
              state.levelXp[lvl] = give;
              remaining -= give;
              if (remaining <= 0) break;
            }
          }

          if (data.levelPrestige) {
            for (const lvl of LEVELS) state.levelPrestige[lvl] = +data.levelPrestige[lvl] || 0;
          }

          state.hoverWords = (data.hoverWords && typeof data.hoverWords === 'object') ? data.hoverWords : {};
          state.savedWords = (data.savedWords && typeof data.savedWords === 'object') ? data.savedWords : {};
          state.feedback = (data.feedback && typeof data.feedback === 'object')
            ? { sentence: String(data.feedback.sentence || ''), generatedAt: +data.feedback.generatedAt || 0 }
            : { sentence: '', generatedAt: 0 };
        } catch (_) {}
      }

      function saveStats() {
        // Legacy single-profile blob (kept for backwards-compat with older versions)
        safeStore.set(STATS_KEY, JSON.stringify({
          totalTexts: state.totalTexts,
          daily: state.daily,
          streakCurrent: state.streakCurrent,
          streakLastDate: state.streakLastDate,
          levelXp: state.levelXp,
          levelPrestige: state.levelPrestige,
          hoverWords: state.hoverWords,
          savedWords: state.savedWords,
          feedback: state.feedback,
        }));
        // Also flush to the active profile so per-member data persists
        if (typeof persistProfiles === 'function' && state.profiles) persistProfiles();
      }

      function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
      function dateOffset(days) {
        const d = new Date();
        d.setDate(d.getDate() - days);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
      function pruneDaily() {
        const cutoff = dateOffset(60);
        for (const k of Object.keys(state.daily)) if (k < cutoff) delete state.daily[k];
      }
      function countWords(text) {
        const m = text.match(/[A-Za-zÄÖÜäöüß]+/g);
        return m ? m.length : 0;
      }
      function getRank(elo) {
        let cur = RANKS[0], next = RANKS[1] || null;
        for (let i = RANKS.length - 1; i >= 0; i--) {
          if (elo >= RANKS[i].min) {
            cur = RANKS[i];
            next = RANKS[i + 1] || null;
            break;
          }
        }
        return { current: cur, next };
      }

      function getDerivedElo() {
        let total = 0;
        for (const lvl of LEVELS) {
          total += state.levelXp[lvl] || 0;
          total += (state.levelPrestige[lvl] || 0) * LEVEL_XP_MAX[lvl];
        }
        return total;
      }

      function isLevelMaxed(lvl) {
        return (state.levelXp[lvl] || 0) >= LEVEL_XP_MAX[lvl];
      }

      function getCurrentSublevel(levelKey) {
        const xp = state.levelXp[levelKey] || 0;
        const max = LEVEL_XP_MAX[levelKey];
        if (xp >= max) return SUBLEVELS[3]; // Max — stays here until prestige
        const progress = xp / max;
        for (let i = SUBLEVELS.length - 1; i >= 0; i--) {
          if (progress >= SUBLEVELS[i].from) return SUBLEVELS[i];
        }
        return SUBLEVELS[0];
      }

      function computeXp(s) {
        if (s.usedEnglish) return 1;
        const levelMult = (LEVEL_BONUS[s.level] || 0) + 1; // 1..5
        const sub = SUBLEVELS.find((x) => x.key === s.subLevelKey) || SUBLEVELS[0];
        let xp = Math.round(8 * levelMult * sub.mult);
        if (sub.timed) {
          if (s.timerExpired) xp = Math.max(2, Math.round(xp * 0.18));
          else xp = Math.round(xp * 1.15);
        }
        return Math.max(1, xp);
      }

      function timerSecondsForText(wordCount) {
        // 0.7s per word, clamped 30..120
        return Math.max(30, Math.min(120, Math.ceil(wordCount * 0.7)));
      }

      const $ = (s, r = document) => r.querySelector(s);
      const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

      const cardLevel = $('#card-level');
      const cardMode = $('#card-mode');
      const cardSublevel = $('#card-sublevel');
      const cardTimerSlot = $('#card-timer-slot');
      const cardBody = $('#card-body');
      const cardFoot = $('#card-foot');
      const viewRead = $('#view-read');
      const viewProgress = $('#view-progress');
      const progressHost = $('#progress-host');

      // radio bindings ---------------------------------------------------

      function bindRadioGroup(attr, target, onChange) {
        $$(`[data-${attr}]`).forEach((btn) => {
          btn.addEventListener('click', () => {
            // view, lang, length, register are always available; mode/level locked while loading
            if (state.loading && attr !== 'view' && attr !== 'lang' && attr !== 'length' && attr !== 'register') return;
            const value = btn.getAttribute(`data-${attr}`);
            state[target] = value;
            syncPressed(attr, value);
            if (onChange) onChange(value);
          });
        });
      }

      function syncPressed(attr, value) {
        $$(`[data-${attr}]`).forEach((b) => {
          const active = b.getAttribute(`data-${attr}`) === value;
          b.setAttribute('aria-pressed', String(active));
          if (b.hasAttribute('role')) b.setAttribute('aria-checked', String(active));
        });
        // Reposition the sliding indicator on the affected toggle group(s)
        requestAnimationFrame(updateAllIndicators);
        // Mirror the change into the Settings modal dropdowns (if initialized)
        if (window.__syncDropdowns) window.__syncDropdowns();
      }

      // Sliding pill indicator — measures the active button and writes
      // --ind-x / --ind-w on the container so the ::before slides with transition.
      const TOGGLE_SELECTOR = '.topbar__levels, .topbar__views, .length-toggle, .mode-toggle, .register-toggle, .lang-toggle';

      function updateIndicator(container) {
        const active = container.querySelector('[aria-pressed="true"]');
        if (!active) return;
        const cRect = container.getBoundingClientRect();
        const aRect = active.getBoundingClientRect();
        if (cRect.width === 0 || aRect.width === 0) return; // hidden / not laid out
        container.style.setProperty('--ind-x', (aRect.left - cRect.left) + 'px');
        container.style.setProperty('--ind-w', aRect.width + 'px');
      }

      function updateAllIndicators() {
        document.querySelectorAll(TOGGLE_SELECTOR).forEach(updateIndicator);
      }

      window.addEventListener('resize', updateAllIndicators);

      // Click anywhere outside an active word dismisses its tooltip
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.word')) clearActiveWords();
      });

      // Text-to-speech via Inworld (high-quality, multilingual).
      // Inworld TTS proxied through /api/tts — auth header added server-side.
      const INWORLD_TTS_URL = '/api/tts';
      const INWORLD_MODEL_ID = 'inworld-tts-1.5-max'; // multilingual, handles German natively
      const INWORLD_AUDIO_CACHE = new Map();         // "voice|text" -> Blob, avoid re-paying for repeats

      const speakBtn = $('#speak-btn');
      let currentAudio = null;
      let currentAudioUrl = null;
      let currentAbort = null;

      function setSpeakingUI(active) {
        speakBtn.classList.toggle('is-speaking', active);
        speakBtn.classList.remove('is-loading');
        speakBtn.setAttribute('aria-label', active ? 'Pause' : 'Read aloud');
        speakBtn.setAttribute('title', active ? 'Pause' : 'Read aloud (German)');
      }
      function setLoadingUI() {
        speakBtn.classList.remove('is-speaking');
        speakBtn.classList.add('is-loading');
        speakBtn.setAttribute('aria-label', 'Loading audio');
        speakBtn.setAttribute('title', 'Loading audio');
      }

      // Yellow karaoke-style word highlight while audio is playing.
      // We track each TTS segment's actual duration (via loadedmetadata on its
      // own MP3 blob) so dialogue voices with different speech rates stay in sync.
      // wordTimings is rebuilt for each generation by buildWordTimings().
      let wordTimings = null;   // [{ el, start, end }, ...]
      let lastHighlightedIdx = -1;

      function clearSpeakingHighlight() {
        $$('.word--speaking', cardBody).forEach((el) => el.classList.remove('word--speaking'));
        lastHighlightedIdx = -1;
      }

      // Read MP3 duration without playing — just loads metadata via a throwaway Audio
      function getBlobDuration(blob) {
        return new Promise((resolve) => {
          const url = URL.createObjectURL(blob);
          const a = new Audio();
          const cleanup = () => URL.revokeObjectURL(url);
          a.addEventListener('loadedmetadata', () => {
            const d = isFinite(a.duration) ? a.duration : 0;
            cleanup();
            resolve(d);
          });
          a.addEventListener('error', () => { cleanup(); resolve(0); });
          a.src = url;
        });
      }

      // Build per-word timing map from segment metadata.
      // Within each segment, words get time slots proportional to their character length.
      function buildWordTimings(segMeta) {
        const wordEls = $$('.word', cardBody);
        const wordRe = /[A-Za-zÄÖÜäöüß]+/g;
        const map = [];
        let elIdx = 0;
        for (const seg of segMeta) {
          const segWords = seg.text.match(wordRe) || [];
          const segChars = segWords.reduce((s, w) => s + w.length, 0) || 1;
          let charSeen = 0;
          for (const w of segWords) {
            if (elIdx >= wordEls.length) break;
            const startRatio = charSeen / segChars;
            const endRatio   = (charSeen + w.length) / segChars;
            map.push({
              el: wordEls[elIdx++],
              start: seg.start + startRatio * seg.duration,
              end:   seg.start + endRatio   * seg.duration,
            });
            charSeen += w.length;
          }
        }
        return map;
      }

      function updateSpeakingHighlight() {
        if (!currentAudio || !wordTimings || !wordTimings.length) return;
        const t = currentAudio.currentTime;
        // Binary search would be faster, but linear is fine for ~200 words
        let activeIdx = -1;
        for (let i = 0; i < wordTimings.length; i++) {
          if (t < wordTimings[i].end) { activeIdx = i; break; }
        }
        if (activeIdx < 0) activeIdx = wordTimings.length - 1;
        if (activeIdx === lastHighlightedIdx) return;
        if (lastHighlightedIdx >= 0 && wordTimings[lastHighlightedIdx]) {
          wordTimings[lastHighlightedIdx].el.classList.remove('word--speaking');
        }
        const target = wordTimings[activeIdx];
        if (target && target.el) target.el.classList.add('word--speaking');
        lastHighlightedIdx = activeIdx;
      }

      function base64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }

      async function fetchInworldAudio(text, signal, voiceOverride) {
        const voice = voiceOverride || state.voiceId || DEFAULT_VOICE;
        const cacheKey = voice + '|' + text;
        const cached = INWORLD_AUDIO_CACHE.get(cacheKey);
        if (cached) { console.log('[TTS] using cached audio for', voice); return cached; }

        console.log('[TTS] fetching:', { voice, textLength: text.length, model: INWORLD_MODEL_ID });

        const res = await fetch(INWORLD_TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice_id: voice,
            language_code: 'de-DE',         // tell Inworld this is German — picks German phonetics
            audio_config: { audio_encoding: 'MP3' },
            model_id: INWORLD_MODEL_ID,
          }),
          signal,
        });

        console.log('[TTS] response status', res.status, 'content-type', res.headers.get('content-type'));

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          console.error('[TTS] error body:', errText);
          throw new Error(`Inworld TTS ${res.status} — ${errText.slice(0, 240)}`);
        }
        if (!res.body) throw new Error('Inworld TTS: no response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let rawDump = '';
        const chunks = [];
        let parsedLines = 0;

        const consumeLine = (line) => {
          const t = line.trim();
          if (!t) return;
          parsedLines++;
          try {
            const obj = JSON.parse(t);
            const audio = (obj.result && obj.result.audioContent) || obj.audioContent;
            if (audio) {
              chunks.push(base64ToBytes(audio));
            } else {
              console.warn('[TTS] line missing audioContent — keys:', Object.keys(obj));
            }
          } catch (e) {
            console.warn('[TTS] non-JSON line:', t.slice(0, 200));
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (rawDump.length < 800) rawDump += chunk;
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) consumeLine(line);
        }
        if (buffer.trim()) consumeLine(buffer);

        console.log('[TTS] parsed lines:', parsedLines, 'audio chunks:', chunks.length);
        if (chunks.length === 0) {
          console.error('[TTS] FIRST 800 CHARS OF RESPONSE:', rawDump);
          throw new Error('Inworld TTS: no audio chunks parsed — see console for raw response');
        }

        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }

        console.log('[TTS] total audio bytes:', total);

        const blob = new Blob([merged], { type: 'audio/mpeg' });
        INWORLD_AUDIO_CACHE.set(cacheKey, blob);
        return blob;
      }

      function disposeAudio() {
        if (currentAudio) {
          try { currentAudio.pause(); } catch (_) {}
          currentAudio = null;
        }
        if (currentAudioUrl) {
          URL.revokeObjectURL(currentAudioUrl);
          currentAudioUrl = null;
        }
      }

      // Called externally (e.g. on new generation) — fully resets state
      function stopSpeaking() {
        if (currentAbort) { currentAbort.abort(); currentAbort = null; }
        disposeAudio();
        clearSpeakingHighlight();
        setSpeakingUI(false);
      }

      // Detect a 2-speaker dialogue (A:/B: speaker labels)
      function isDialogue(text) {
        const matches = text.match(/^[A-Z]:\s+/gm);
        if (!matches || matches.length < 2) return false;
        const speakers = new Set(matches.map((s) => s[0]));
        return speakers.size >= 2;
      }

      // Split a dialogue into ordered { speaker, text } segments.
      function splitDialogueSegments(text) {
        const segments = [];
        let lastSpeaker = null;
        for (const rawLine of text.split(/\n+/)) {
          const line = rawLine.trim();
          if (!line) continue;
          const m = line.match(/^([A-Z]):\s+(.*)$/s);
          if (m) {
            lastSpeaker = m[1];
            segments.push({ speaker: m[1], text: m[2] });
          } else {
            segments.push({ speaker: lastSpeaker, text: line });
          }
        }
        return segments;
      }

      // Pick distinct voices for each speaker. User's selected voice is one of them
      // (so they hear their preference); the other speaker(s) get random remaining voices.
      function pickDialogueVoiceMap(speakers) {
        const main = state.voiceId || DEFAULT_VOICE;
        const others = GERMAN_VOICES
          .map((v) => v.id)
          .filter((id) => id !== main);
        // Shuffle others
        for (let i = others.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [others[i], others[j]] = [others[j], others[i]];
        }
        const map = {};
        const order = [main, ...others];
        speakers.forEach((sp, i) => {
          map[sp] = order[i % order.length] || main;
        });
        return map;
      }

      async function fetchDialogueAudio(text, signal) {
        const segments = splitDialogueSegments(text);
        const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
        const voiceMap = pickDialogueVoiceMap(speakers);
        console.log('[TTS] dialogue voice map:', voiceMap);

        // Fetch each segment with its assigned voice + measure its duration
        const blobs = [];
        const segMeta = [];
        let cumDur = 0;
        for (const seg of segments) {
          const v = (seg.speaker && voiceMap[seg.speaker]) || (state.voiceId || DEFAULT_VOICE);
          const blob = await fetchInworldAudio(seg.text, signal, v);
          const dur = await getBlobDuration(blob);
          segMeta.push({ text: seg.text, start: cumDur, duration: dur });
          cumDur += dur;
          blobs.push(blob);
        }

        // Build per-word timing map for highlight sync — uses real per-voice durations
        wordTimings = buildWordTimings(segMeta);
        console.log('[TTS] built timing map:', wordTimings.length, 'words across', segMeta.length, 'segments');

        // Concatenate the MP3 byte streams.
        const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
        const total = buffers.reduce((s, b) => s + b.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const buf of buffers) {
          merged.set(new Uint8Array(buf), off);
          off += buf.byteLength;
        }
        return new Blob([merged], { type: 'audio/mpeg' });
      }

      function showTtsError(msg) {
        console.error('[TTS]', msg);
        // Tiny inline notice so the user sees that something went wrong.
        let t = document.getElementById('tts-error-toast');
        if (!t) {
          t = document.createElement('div');
          t.id = 'tts-error-toast';
          t.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:300;padding:10px 14px;background:rgba(60,16,16,0.95);color:#fff;border:1px solid rgba(255,120,120,0.4);border-radius:6px;font:13px Sora,sans-serif;max-width:520px;';
          document.body.appendChild(t);
        }
        t.textContent = msg;
        clearTimeout(t._timer);
        t._timer = setTimeout(() => { t.remove(); }, 6000);
      }

      async function startSpeaking(text) {
        if (!text) return;
        console.log('[TTS] startSpeaking — voice:', state.voiceId, 'len:', text.length);
        currentAbort = new AbortController();
        setLoadingUI(); // spinner while we fetch

        try {
          const useDialogue = isDialogue(text);
          console.log('[TTS] mode:', useDialogue ? 'dialogue (multi-voice)' : 'single voice');
          let blob;
          if (useDialogue) {
            // fetchDialogueAudio builds wordTimings internally
            blob = await fetchDialogueAudio(text, currentAbort.signal);
          } else {
            blob = await fetchInworldAudio(text, currentAbort.signal);
            // single-segment timing map
            const dur = await getBlobDuration(blob);
            wordTimings = buildWordTimings([{ text, start: 0, duration: dur }]);
            console.log('[TTS] built timing map:', wordTimings.length, 'words');
          }
          if (!currentAbort) return;
          console.log('[TTS] blob ready —', blob.size, 'bytes,', blob.type);

          disposeAudio();
          currentAudioUrl = URL.createObjectURL(blob);
          currentAudio = new Audio(currentAudioUrl);
          currentAudio.addEventListener('canplay',  () => console.log('[TTS] canplay'));
          currentAudio.addEventListener('playing',  () => console.log('[TTS] playing'));
          currentAudio.addEventListener('timeupdate', updateSpeakingHighlight);
          currentAudio.addEventListener('ended', () => {
            clearSpeakingHighlight();
            disposeAudio();
            setSpeakingUI(false);
          });
          currentAudio.addEventListener('error', (ev) => {
            const err = currentAudio && currentAudio.error;
            console.error('[TTS] audio element error', err && err.code, err && err.message);
            showTtsError('Audio failed to load (browser couldn\'t decode the MP3). Check the console.');
            clearSpeakingHighlight();
            disposeAudio();
            setSpeakingUI(false);
          });
          setSpeakingUI(true);
          try {
            await currentAudio.play();
          } catch (playErr) {
            console.error('[TTS] play() rejected:', playErr);
            showTtsError('Audio playback blocked: ' + (playErr.message || playErr));
            stopSpeaking();
          }
        } catch (e) {
          if (e && e.name === 'AbortError') { setSpeakingUI(false); return; }
          console.error('Inworld TTS failed:', e);
          showTtsError(String(e.message || e));
          stopSpeaking();
        } finally {
          currentAbort = null;
        }
      }

      speakBtn.addEventListener('click', () => {
        // Pause if currently playing
        if (currentAudio && !currentAudio.paused && !currentAudio.ended) {
          currentAudio.pause();
          setSpeakingUI(false);
          return;
        }
        // Resume if paused mid-track
        if (currentAudio && currentAudio.paused && currentAudio.currentTime > 0 && !currentAudio.ended) {
          setSpeakingUI(true);
          currentAudio.play().catch(() => stopSpeaking());
          return;
        }
        // Otherwise fetch + play fresh
        const text = state.lastData?.text;
        if (!text) return;
        startSpeaking(text);
      });

      // Stop audio when tab is hidden — don't waste data / be polite
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && currentAudio && !currentAudio.paused) {
          currentAudio.pause();
          setSpeakingUI(false);
        }
      });

      // Settings modal infrastructure
      const settingsBtn = $('#settings-btn');
      const settingsModal = $('#settings-modal');
      const settingsBackdrop = $('#settings-backdrop');
      const settingsClose = $('#settings-close');

      function openSettings() {
        settingsModal.hidden = false;
        document.body.classList.add('modal-open');   // disables expensive topbar blur underneath
        renderProfileSwitcher();
        fillProfileForm();
      }
      function closeSettings() {
        settingsModal.hidden = true;
        document.body.classList.remove('modal-open');
      }
      settingsBtn.addEventListener('click', openSettings);
      settingsClose.addEventListener('click', closeSettings);
      settingsBackdrop.addEventListener('click', closeSettings);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
      });

      // ───────────────────────────────────────────────────────────────
      // JOURNAL — AI-conversational profile
      //
      // The user chats with a tutor. Each turn, we ask DeepSeek to:
      //   1. Reply naturally in 1–2 sentences with one warm follow-up
      //   2. Extract any new profile facts as structured JSON
      //   3. (after enough info) write a personalised "About you" + plan
      // The reply renders as a tutor message; the extracted fields merge
      // into the active profile silently. After ~3 turns we render the
      // generated cards.
      // ───────────────────────────────────────────────────────────────
      const journalAvatarEl        = $('#journal-avatar');
      const journalAvatarInitialEl = $('#journal-avatar-initial');
      const journalAvatarInput     = $('#journal-avatar-input');
      const journalFamilyEl        = $('#journal-family');
      const journalSummaryEl       = $('#journal-summary');
      const journalSummaryBodyEl   = $('#journal-summary-body');
      const journalFactsEl         = $('#journal-facts');
      const journalSummaryEditEl   = $('#journal-summary-edit');
      const journalPlanEl          = $('#journal-plan');
      const journalPlanBodyEl      = $('#journal-plan-body');
      const journalPlanRefreshEl   = $('#journal-plan-refresh');
      const journalThreadEl        = $('#journal-thread');
      const journalSuggestionsEl   = $('#journal-suggestions');
      const journalFormEl          = $('#journal-form');
      const journalFieldEl         = $('#journal-field');
      const journalSendEl          = $('#journal-send');
      const journalEditorEl        = $('#journal-editor');
      const journalEditorDoneEl    = $('#journal-editor-done');
      const journalChatEl          = $('#journal-chat');
      const journalHeroSubEl       = $('#journal-hero-sub');

      const PROFILE_FIELDS = ['name', 'age', 'occupation', 'hobbies', 'location', 'goals', 'weakAreas'];

      // One-time migration: legacy chip-array weakAreas → free-form string,
      // and ensure every profile has a chat history container.
      (function migrateProfile() {
        for (const id of Object.keys(state.profiles || {})) {
          const p = state.profiles[id];
          if (Array.isArray(p.weakAreas)) {
            p.weakAreas = p.weakAreas
              .map((wid) => {
                const w = (typeof WEAK_AREAS !== 'undefined') ? WEAK_AREAS.find((x) => x.id === wid) : null;
                return w ? w.label.toLowerCase() : wid;
              })
              .filter(Boolean)
              .join(', ');
          } else if (p.weakAreas == null) {
            p.weakAreas = '';
          }
          if (!Array.isArray(p.journalHistory)) p.journalHistory = [];
          if (typeof p.journalSummary !== 'string') p.journalSummary = '';
          if (typeof p.journalPlan    !== 'string') p.journalPlan    = '';
        }
      })();

      function profileFilledCount(p) {
        if (!p) return 0;
        return PROFILE_FIELDS.filter((f) => p[f] && String(p[f]).trim()).length;
      }

      function updateJournalAvatar() {
        const p = getActiveProfile();
        if (!p || !journalAvatarEl) return;
        const initial = (p.name || '').trim()[0]?.toUpperCase() || '';
        if (p.avatar) {
          journalAvatarEl.style.backgroundImage = `url(${p.avatar})`;
          journalAvatarEl.classList.add('j-hero__avatar--has-photo');
          if (journalAvatarInitialEl) journalAvatarInitialEl.textContent = '';
        } else {
          journalAvatarEl.style.backgroundImage = '';
          journalAvatarEl.classList.remove('j-hero__avatar--has-photo');
          if (journalAvatarInitialEl) journalAvatarInitialEl.textContent = initial || '·';
        }
        // Hero sub-line — adapts to how much the tutor knows
        if (journalHeroSubEl) {
          const filled = profileFilledCount(p);
          journalHeroSubEl.textContent = filled === 0
            ? "Tell your tutor a little about yourself — they'll write your texts around it."
            : filled < 4
              ? `Your tutor is getting to know you. Keep going.`
              : `Your tutor has a clear picture. Generated texts will reflect this.`;
        }
      }

      function renderJournalFamily() {
        if (!journalFamilyEl) return;
        const ids = Object.keys(state.profiles || {});
        const chips = ids.map((id) => {
          const p = state.profiles[id];
          const active = id === state.activeProfileId;
          const initial = (p.name || '').trim()[0]?.toUpperCase() || '·';
          const av = p.avatar
            ? `<span class="j-member__av" style="background-image:url(${p.avatar})"></span>`
            : `<span class="j-member__av">${escapeHtml(initial)}</span>`;
          return `<button type="button" class="j-member${active ? ' is-active' : ''}" data-profile-id="${escapeAttr(id)}" aria-pressed="${active}">${av}<span class="j-member__name">${escapeHtml(p.name || 'Unnamed')}</span></button>`;
        }).join('');
        const addBtn = `<button type="button" class="j-member-add" id="journal-member-add" aria-label="Add family member">+</button>`;
        const removeBtn = ids.length > 1
          ? `<button type="button" class="j-member-remove" id="journal-member-remove">Remove</button>`
          : '';
        journalFamilyEl.innerHTML = `<div class="j-family__row">${chips}${addBtn}${removeBtn}</div>`;
      }

      // Render summary + plan cards from saved AI output
      function renderJournalCards() {
        const p = getActiveProfile();
        if (!p) return;
        const filled = profileFilledCount(p);

        // Summary card
        if (journalSummaryEl && journalSummaryBodyEl) {
          if (p.journalSummary && p.journalSummary.trim()) {
            journalSummaryBodyEl.textContent = p.journalSummary;
            renderJournalFacts(p);
            journalSummaryEl.hidden = false;
          } else {
            journalSummaryEl.hidden = true;
          }
        }

        // Plan card — only after 3+ filled fields, even if no AI plan yet
        if (journalPlanEl && journalPlanBodyEl) {
          if (p.journalPlan && p.journalPlan.trim()) {
            journalPlanBodyEl.textContent = p.journalPlan;
            journalPlanEl.hidden = false;
          } else {
            journalPlanEl.hidden = true;
          }
        }
        // Hide suggestion chips once the user has actually shared anything
        if (journalSuggestionsEl) {
          journalSuggestionsEl.hidden = filled > 0 || (p.journalHistory && p.journalHistory.length > 0);
        }
      }

      function renderJournalFacts(p) {
        if (!journalFactsEl) return;
        const facts = [];
        const labels = {
          age: 'AGE', occupation: 'WORK', location: 'WHERE',
          hobbies: 'INTERESTS', goals: 'GOAL', weakAreas: 'WORKING ON',
        };
        for (const f of ['age', 'occupation', 'location', 'hobbies', 'goals', 'weakAreas']) {
          const v = (p[f] || '').toString().trim();
          if (!v) continue;
          const short = v.length > 48 ? v.slice(0, 45).trim() + '…' : v;
          facts.push(`<li><b>${labels[f]}</b>${escapeHtml(short)}</li>`);
        }
        journalFactsEl.innerHTML = facts.join('');
      }

      // Fill every [data-profile-field] input/textarea (used by the editor)
      function fillProfileForm() {
        const p = getActiveProfile();
        if (!p) return;
        $$('[data-profile-field]').forEach((input) => {
          const field = input.dataset.profileField;
          input.value = (p[field] != null) ? String(p[field]) : '';
        });
        updateJournalAvatar();
        renderJournalFamily();
        renderJournalCards();
        renderJournalThread();
      }

      // Render the conversation thread from the active profile's history
      function renderJournalThread() {
        if (!journalThreadEl) return;
        const p = getActiveProfile();
        if (!p) return;
        const hist = p.journalHistory || [];

        if (hist.length === 0) {
          // Opening tutor message
          journalThreadEl.innerHTML = `
            <div class="j-msg j-msg--tutor">Hey — I'm your tutor. The more I know about you, the more your texts will sound like your actual life. So: <em>who are you?</em> Anything works — what you do, where you are, why you started learning German.</div>
          `;
        } else {
          journalThreadEl.innerHTML = hist.map((m) => {
            if (m.role === 'tutor') return `<div class="j-msg j-msg--tutor">${escapeHtml(m.text)}</div>`;
            if (m.role === 'user')  return `<div class="j-msg j-msg--user">${escapeHtml(m.text)}</div>`;
            if (m.role === 'saved') return `<div class="j-msg j-msg--saved">${escapeHtml(m.text)}</div>`;
            return '';
          }).join('');
        }
        // Scroll thread into view if it's now tall
        requestAnimationFrame(() => {
          if (journalChatEl) journalChatEl.scrollIntoView({ block: 'end', behavior: 'smooth' });
        });
      }

      // Auto-grow textarea
      function autoGrowField() {
        if (!journalFieldEl) return;
        journalFieldEl.style.height = 'auto';
        journalFieldEl.style.height = Math.min(journalFieldEl.scrollHeight, 160) + 'px';
        if (journalSendEl) journalSendEl.disabled = !journalFieldEl.value.trim();
      }

      if (journalFieldEl) {
        journalFieldEl.addEventListener('input', autoGrowField);
        journalFieldEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (journalFormEl) journalFormEl.requestSubmit();
          }
        });
      }

      // Suggestion chips — fill the input with the suggestion text
      if (journalSuggestionsEl && journalFieldEl) {
        journalSuggestionsEl.addEventListener('click', (e) => {
          const chip = e.target.closest('.j-chip');
          if (!chip) return;
          journalFieldEl.value = chip.dataset.suggest || chip.textContent || '';
          autoGrowField();
          journalFieldEl.focus();
        });
      }

      // Wire editor inputs — manual override of profile fields
      $$('[data-profile-field]').forEach((input) => {
        input.addEventListener('input', () => {
          const p = getActiveProfile();
          if (!p) return;
          const field = input.dataset.profileField;
          p[field] = input.value;
          updateJournalAvatar();
          if (field === 'name') renderJournalFamily();
          persistProfiles();
        });
      });

      // Open / close the editor
      if (journalSummaryEditEl && journalEditorEl) {
        journalSummaryEditEl.addEventListener('click', () => {
          fillProfileForm();
          journalEditorEl.hidden = false;
          journalEditorEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
      if (journalEditorDoneEl && journalEditorEl) {
        journalEditorDoneEl.addEventListener('click', () => {
          journalEditorEl.hidden = true;
          renderJournalCards();
        });
      }

      // Family ribbon — switch / add / remove
      if (journalFamilyEl) {
        journalFamilyEl.addEventListener('click', (e) => {
          const addBtn = e.target.closest('#journal-member-add');
          if (addBtn) {
            const name = (window.prompt('Name for the new family member?', '') || '').trim();
            if (!name) return;
            const newId = createProfileWithName(name);
            switchProfile(newId);
            fillProfileForm();
            return;
          }
          const removeBtn = e.target.closest('#journal-member-remove');
          if (removeBtn) {
            if (Object.keys(state.profiles).length <= 1) return;
            const p = getActiveProfile();
            const name = (p && p.name) ? p.name : 'this profile';
            if (!window.confirm(`Remove ${name}? Their saved words and progress will be lost.`)) return;
            deleteProfile(state.activeProfileId);
            fillProfileForm();
            return;
          }
          const member = e.target.closest('.j-member');
          if (member) {
            switchProfile(member.dataset.profileId);
            fillProfileForm();
          }
        });
      }

      // Avatar upload
      if (journalAvatarEl && journalAvatarInput) {
        journalAvatarEl.addEventListener('click', () => journalAvatarInput.click());
        journalAvatarInput.addEventListener('change', () => {
          const file = journalAvatarInput.files && journalAvatarInput.files[0];
          if (!file) return;
          if (!/^image\//.test(file.type)) { alert('Please pick an image file.'); return; }
          if (file.size > 4 * 1024 * 1024)  { alert('That image is too big — under 4MB please.'); return; }
          const reader = new FileReader();
          reader.onload = () => {
            const p = getActiveProfile();
            if (!p) return;
            downscaleImage(String(reader.result), 256, (smallDataUrl) => {
              p.avatar = smallDataUrl;
              persistProfiles();
              updateJournalAvatar();
              renderJournalFamily();
            });
          };
          reader.readAsDataURL(file);
          journalAvatarInput.value = '';
        });
      }

      // ── AI: extract profile facts + reply naturally ──────────────
      async function callJournalAI(systemPrompt, userMsg, expectsJson = true) {
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMsg },
        ];
        const body = {
          model: 'deepseek-chat',
          messages,
          temperature: 0.7,
          max_tokens: 600,
        };
        if (expectsJson) body.response_format = { type: 'json_object' };

        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('AI request failed (' + res.status + ')');
        const json = await res.json();
        const txt = json?.choices?.[0]?.message?.content || '';
        if (!expectsJson) return txt;
        try { return JSON.parse(txt); } catch (_) { return null; }
      }

      function showTyping() {
        if (!journalThreadEl) return;
        const t = document.createElement('div');
        t.className = 'j-typing';
        t.id = 'journal-typing';
        t.innerHTML = '<span></span><span></span><span></span>';
        journalThreadEl.appendChild(t);
        if (journalChatEl) journalChatEl.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
      function hideTyping() {
        const t = document.getElementById('journal-typing');
        if (t) t.remove();
      }

      // The big tutor system prompt. We ask it to return strict JSON that
      // contains both a chat reply and structured profile updates.
      const JOURNAL_SYSTEM_PROMPT = `You are a warm, low-key German tutor talking with a learner who is filling in their profile so you can write personalised reading texts for them.

Your job each turn:
1. Read the user's message naturally.
2. Update the structured profile object with anything they newly share. Only include fields you have a direct mention of — do NOT invent or guess. Leave fields you don't have info on out entirely.
3. Reply with ONE warm, casual sentence acknowledging what they said, then ONE follow-up question that goes a layer deeper. Sound human, not corporate. No emojis. No "great!". Be a real person.
4. If the user has already shared substantial info (name, what they do, why German, location at minimum), set "summary" to a 1–2 sentence "about you" paragraph in second person ("You're a designer in Berlin, learning German because…"). Otherwise set summary to empty string.
5. If summary is non-empty, also write "plan": a 2–3 sentence personalised teaching plan in second person that says what kinds of texts you'll generate for them. Reference specific German cultural touchstones (Späti, Wochenmarkt, U-Bahn, Anmeldung, WG, Hausmeister, Pfand, etc) where it fits their life. Otherwise set plan to empty string.

Return STRICT JSON only:
{
  "reply": "string",
  "extracted": { "name": "...", "age": "...", "occupation": "...", "hobbies": "...", "location": "...", "goals": "...", "weakAreas": "..." },
  "summary": "string (or empty)",
  "plan": "string (or empty)"
}

Only include fields in "extracted" that you actually learned this turn. Existing values: ${'${EXISTING}'}.`;

      async function handleJournalSend(userText) {
        const p = getActiveProfile();
        if (!p || !userText.trim()) return;

        // Append user message
        p.journalHistory = p.journalHistory || [];
        p.journalHistory.push({ role: 'user', text: userText.trim() });
        renderJournalThread();
        renderJournalCards();
        persistProfiles();

        showTyping();
        try {
          const existingSummary = PROFILE_FIELDS
            .map((f) => `${f}: ${(p[f] || '').toString().trim() || '(unknown)'}`)
            .join('; ');
          const sys = JOURNAL_SYSTEM_PROMPT.replace('${EXISTING}', existingSummary);

          // Build conversation context — last 6 turns
          const recent = (p.journalHistory || []).slice(-12)
            .map((m) => (m.role === 'user' ? 'USER: ' : m.role === 'tutor' ? 'TUTOR: ' : '') + m.text)
            .filter(Boolean)
            .join('\n');

          const result = await callJournalAI(sys, `Conversation so far:\n${recent}\n\nNow respond.`, true);
          hideTyping();

          if (!result || typeof result !== 'object') throw new Error('Bad JSON from AI');

          // Merge extracted fields
          const ex = result.extracted || {};
          let extractedKeys = [];
          for (const f of PROFILE_FIELDS) {
            const v = ex[f];
            if (typeof v === 'string' && v.trim()) {
              p[f] = v.trim();
              extractedKeys.push(f);
            }
          }

          // Save AI summary + plan if they came back non-empty
          if (typeof result.summary === 'string' && result.summary.trim()) {
            p.journalSummary = result.summary.trim();
          }
          if (typeof result.plan === 'string' && result.plan.trim()) {
            p.journalPlan = result.plan.trim();
          }

          // Tutor's reply
          const reply = (result.reply || '').toString().trim();
          if (reply) {
            p.journalHistory.push({ role: 'tutor', text: reply });
          }
          // Subtle "saved" notice if we extracted anything
          if (extractedKeys.length > 0) {
            const labelMap = {
              name: 'name', age: 'age', occupation: 'what you do',
              hobbies: 'interests', location: 'where you are',
              goals: 'why German', weakAreas: 'what to work on',
            };
            const labels = extractedKeys.map((k) => labelMap[k] || k).join(', ');
            p.journalHistory.push({ role: 'saved', text: `Saved: ${labels}` });
          }

          persistProfiles();
          updateJournalAvatar();
          renderJournalFamily();
          renderJournalCards();
          renderJournalThread();
        } catch (err) {
          hideTyping();
          p.journalHistory.push({
            role: 'tutor',
            text: "Hmm, I lost the thread for a sec — the network blipped. Could you try that again?",
          });
          persistProfiles();
          renderJournalThread();
        }
      }

      if (journalFormEl) {
        journalFormEl.addEventListener('submit', (e) => {
          e.preventDefault();
          const txt = (journalFieldEl?.value || '').trim();
          if (!txt) return;
          journalFieldEl.value = '';
          autoGrowField();
          handleJournalSend(txt);
        });
      }

      // Refresh plan — re-asks AI to write a new plan from the existing profile
      if (journalPlanRefreshEl) {
        journalPlanRefreshEl.addEventListener('click', async () => {
          const p = getActiveProfile();
          if (!p || profileFilledCount(p) < 3) return;
          journalPlanRefreshEl.disabled = true;
          try {
            const profileBlock = PROFILE_FIELDS
              .map((f) => `${f}: ${(p[f] || '').toString().trim() || '(unknown)'}`)
              .join('\n');
            const sys = `You write personalised German-learning plans for a learner. Write 2–3 sentences in second person describing the kinds of texts you'll generate for them — reference real German cultural touchstones (Späti, Wochenmarkt, U-Bahn, Anmeldung, WG, Hausmeister, Pfand, etc) where they fit their life. Return strict JSON: { "plan": "string" }`;
            const result = await callJournalAI(sys, `Their profile:\n${profileBlock}\n\nWrite their plan.`, true);
            if (result && typeof result.plan === 'string' && result.plan.trim()) {
              p.journalPlan = result.plan.trim();
              persistProfiles();
              renderJournalCards();
            }
          } catch (_) { /* silent */ }
          journalPlanRefreshEl.disabled = false;
        });
      }

      // Downscale via canvas — keeps localStorage tiny even with many profiles
      function downscaleImage(dataUrl, maxDim, cb) {
        const img = new Image();
        img.onload = () => {
          const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.round(img.width * ratio);
          const h = Math.round(img.height * ratio);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          cb(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => cb(dataUrl);
        img.src = dataUrl;
      }

      // Initial render of journal so it's ready when user clicks the tab
      fillProfileForm();

      // Called when active profile changes — pulls all per-profile state into the UI
      function onActiveProfileChanged() {
        // Re-sync UI (dropdowns, dropdown indicators, stats panel, etc.)
        if (typeof syncDropdownsFromState === 'function') syncDropdownsFromState();
        if (typeof syncPressed === 'function') {
          syncPressed('mode', state.mode);
          syncPressed('level', state.level);
          syncPressed('length', state.length);
          syncPressed('register', state.register);
        }
        if (typeof renderStats === 'function') renderStats();
        if (typeof updateHeadIfIdle === 'function') updateHeadIfIdle();
        if (typeof updateSublevelPillIfIdle === 'function') updateSublevelPillIfIdle();
      }

      // Spacebar toggles play/pause from anywhere in the reader (not in inputs / settings)
      document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        const tgt = e.target;
        const tag = tgt && tgt.tagName ? tgt.tagName.toLowerCase() : '';
        if (['input', 'textarea', 'select', 'button'].includes(tag)) return;
        if (tgt && tgt.isContentEditable) return;
        if (!settingsModal.hidden) return;            // typing in settings
        if (!state.lastData?.text) return;            // nothing to play yet
        if (state.view !== 'read') return;            // not on the reader view
        e.preventDefault();
        speakBtn.click();
      });

      // ─── Right-click context menu on words ────────────────────────────
      const ctxMenu = $('#ctx-menu');
      let ctxTargetWord = null;

      function showCtxMenuAt(target, clientX, clientY) {
        ctxTargetWord = target;
        ctxMenu.hidden = false;
        ctxMenu.style.left = '0px';
        ctxMenu.style.top = '0px';
        const rect = ctxMenu.getBoundingClientRect();
        const x = Math.min(clientX, window.innerWidth - rect.width - 8);
        const y = Math.min(clientY, window.innerHeight - rect.height - 8);
        ctxMenu.style.left = Math.max(8, x) + 'px';
        ctxMenu.style.top = Math.max(8, y) + 'px';
      }

      cardBody.addEventListener('contextmenu', (e) => {
        const w = e.target.closest('.word');
        if (!w) return;
        e.preventDefault();
        showCtxMenuAt(w, e.clientX, e.clientY);
      });

      // ─── Mobile long-press → context menu ─────────────────────────────
      // Touchscreens have no right-click. Hold a word for ~500ms to open
      // the same menu (Show meaning / Play audio from here).
      let longPressTimer = null;
      let longPressTarget = null;
      let longPressFiredFor = null;          // word the long-press just opened on; suppress the synthetic click
      const LONG_PRESS_MS = 500;

      cardBody.addEventListener('touchstart', (e) => {
        const w = e.target.closest('.word');
        if (!w) return;
        longPressTarget = w;
        const touch = e.touches[0];
        const startX = touch.clientX;
        const startY = touch.clientY;
        longPressTimer = setTimeout(() => {
          if (longPressTarget === w) {
            longPressFiredFor = w;
            showCtxMenuAt(w, startX, startY);
            // Brief haptic feedback if available
            if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
          }
        }, LONG_PRESS_MS);
      }, { passive: true });

      const cancelLongPress = () => {
        longPressTarget = null;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      };
      cardBody.addEventListener('touchend',    cancelLongPress, { passive: true });
      cardBody.addEventListener('touchcancel', cancelLongPress, { passive: true });
      cardBody.addEventListener('touchmove',   cancelLongPress, { passive: true });
      document.addEventListener('click', (e) => {
        if (!ctxMenu.hidden && !e.target.closest('.ctx-menu')) {
          ctxMenu.hidden = true;
          ctxTargetWord = null;
        }
      });
      window.addEventListener('scroll', () => {
        if (!ctxMenu.hidden) { ctxMenu.hidden = true; ctxTargetWord = null; }
      }, true);
      ctxMenu.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-ctx]');
        if (!item || !ctxTargetWord) return;
        const action = item.dataset.ctx;
        const target = ctxTargetWord;
        ctxMenu.hidden = true;
        ctxTargetWord = null;
        if (action === 'meaning') {
          // Same flow as a left-click on the word
          onWordClick({
            currentTarget: target,
            target,
            stopPropagation() {},
          });
        } else if (action === 'play') {
          await playFromWord(target);
        }
      });

      async function playFromWord(wordEl) {
        const text = state.lastData?.text;
        if (!text) return;

        // Need audio — fetch if not already loaded
        if (!currentAudio) {
          await startSpeaking(text);
          // wait for it to be playable
          if (!currentAudio) return;
        }
        // Wait for duration metadata if not yet available
        if (!isFinite(currentAudio.duration) || currentAudio.duration <= 0) {
          await new Promise((resolve) => {
            const onMeta = () => {
              currentAudio.removeEventListener('loadedmetadata', onMeta);
              resolve();
            };
            currentAudio.addEventListener('loadedmetadata', onMeta);
          });
        }

        const wordEls = $$('.word', cardBody);
        const idx = wordEls.indexOf(wordEl);
        if (idx < 0) return;
        const lengths = wordEls.map((el) => (el.dataset.word || '').length || 1);
        const total = lengths.reduce((a, b) => a + b, 0);
        if (!total) return;
        let charsBefore = 0;
        for (let i = 0; i < idx; i++) charsBefore += lengths[i];
        const startSec = (charsBefore / total) * currentAudio.duration;
        currentAudio.currentTime = Math.max(0, startSec - 0.05);
        try { await currentAudio.play(); setSpeakingUI(true); } catch (_) {}
      }

      // ─── Custom dropdown component ───────────────────────────────────
      function makeDropdown(container, options, currentValue, onChange) {
        // Clean up listeners from a previous makeDropdown call on this container
        if (container._dropdownCleanup) container._dropdownCleanup();

        const cur = options.find((o) => String(o.value) === String(currentValue)) || options[0];
        container.innerHTML =
          `<button type="button" class="dropdown__btn" aria-haspopup="listbox" aria-expanded="false">` +
            `<span class="dropdown__value"></span>` +
            `<svg class="dropdown__chev" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5l4 4 4-4"/></svg>` +
          `</button>` +
          `<div class="dropdown__menu" role="listbox" hidden>` +
            options.map((opt) => {
              const sel = String(opt.value) === String(currentValue);
              return `<button type="button" class="dropdown__option${sel ? ' is-selected' : ''}" data-value="${escapeAttr(String(opt.value))}" role="option" aria-selected="${sel}">` +
                `<span>${escapeHtml(opt.label)}</span>` +
                `<svg class="dropdown__option-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 5"/></svg>` +
              `</button>`;
            }).join('') +
          `</div>`;

        const btn = container.querySelector('.dropdown__btn');
        const valueEl = container.querySelector('.dropdown__value');
        const menu = container.querySelector('.dropdown__menu');
        valueEl.textContent = cur.label;

        function setValue(value) {
          const found = options.find((o) => String(o.value) === String(value));
          if (!found) return;
          valueEl.textContent = found.label;
          menu.querySelectorAll('.dropdown__option').forEach((el) => {
            const isMatch = el.dataset.value === String(value);
            el.classList.toggle('is-selected', isMatch);
            el.setAttribute('aria-selected', String(isMatch));
          });
        }
        function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
        function open()  { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }

        const onBtnClick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Close all OTHER open dropdowns first
          document.querySelectorAll('.dropdown__menu:not([hidden])').forEach((m) => {
            if (m !== menu) {
              m.hidden = true;
              const otherBtn = m.parentElement.querySelector('.dropdown__btn');
              if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
            }
          });
          if (menu.hidden) open(); else close();
        };
        const onMenuClick = (e) => {
          const opt = e.target.closest('[data-value]');
          if (!opt) return;
          e.preventDefault();
          e.stopPropagation();
          const value = opt.dataset.value;
          setValue(value);
          close();
          onChange(value);
        };
        const onDocClick = (e) => {
          if (!container.contains(e.target)) close();
        };

        btn.addEventListener('click', onBtnClick);
        menu.addEventListener('click', onMenuClick);
        document.addEventListener('click', onDocClick);

        // Store cleanup so the next makeDropdown call removes old listeners
        container._dropdownCleanup = () => {
          document.removeEventListener('click', onDocClick);
        };

        return { setValue };
      }

      // Initialize all 5 settings dropdowns
      const ddLevel = makeDropdown($('#dd-level'),
        LEVELS.map((l) => ({ value: l, label: l })),
        state.level,
        (v) => {
          if (state.loading) { ddLevel.setValue(state.level); return; }
          state.level = v;
          syncPressed('level', v);
          updateHeadIfIdle();
          updateSublevelPillIfIdle();
          persistProfiles();
        });

      const ddLength = makeDropdown($('#dd-length'),
        LENGTHS.map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) })),
        state.length,
        (v) => {
          state.length = v;
          safeStore.set('deutschify:length', v);
          syncPressed('length', v);
          persistProfiles();
        });

      const ddMode = makeDropdown($('#dd-mode'),
        Object.entries(MODE_LABELS).map(([k, lbl]) => ({ value: k, label: lbl })),
        state.mode,
        (v) => {
          if (state.loading) { ddMode.setValue(state.mode); return; }
          state.mode = v;
          syncPressed('mode', v);
          updateHeadIfIdle();
          persistProfiles();
        });

      const ddRegister = makeDropdown($('#dd-register'),
        REGISTERS.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) })),
        state.register,
        (v) => {
          state.register = v;
          safeStore.set('deutschify:register', v);
          syncPressed('register', v);
          persistProfiles();
        });

      function buildVoiceDropdown() {
        return makeDropdown($('#dd-voice'),
          GERMAN_VOICES.map((v) => ({ value: v.id, label: v.label })),
          state.voiceId,
          (v) => {
            state.voiceId = v;
            safeStore.set('deutschify:voice', v);
            stopSpeaking();
            persistProfiles();
          });
      }
      let ddVoice = buildVoiceDropdown();

      function syncDropdownsFromState() {
        ddLevel.setValue(state.level);
        ddLength.setValue(state.length);
        ddMode.setValue(state.mode);
        ddRegister.setValue(state.register);
        ddVoice.setValue(state.voiceId);
      }
      // Expose so syncPressed can call it
      window.__syncDropdowns = syncDropdownsFromState;

      // Fetch Inworld's full voice catalog and filter to true German voices
      (async function loadGermanVoices() {
        try {
          const res = await fetch('/api/voices', {
            headers: { 'Accept': 'application/json' },
          });
          console.log('[Voices] /voices status:', res.status);
          if (!res.ok) {
            console.warn('[Voices] body:', (await res.text().catch(() => '')).slice(0, 240));
            return;
          }
          const data = await res.json();
          console.log('[Voices] raw catalog:', data);

          // Try common shapes
          const all = Array.isArray(data) ? data
                    : (data.voices || data.results || data.voice || []);
          if (!Array.isArray(all) || !all.length) {
            console.warn('[Voices] unexpected response shape — keeping fallback list');
            return;
          }

          // Filter to voices that explicitly list a German language code
          const german = all.filter((v) => {
            const langField = v.languages || v.supportedLanguages || v.language || v.language_codes || [];
            const arr = Array.isArray(langField) ? langField : [langField];
            return arr.some((l) => {
              const code = typeof l === 'string' ? l : (l && (l.code || l.language || l.languageCode || l.id) || '');
              return /^de(-|$)/i.test(code);
            });
          });

          console.log('[Voices] German-capable:', german.length, 'of', all.length);
          if (german.length === 0) {
            console.log('[Voices] full list (no de filter possible):',
              all.map((v) => v.voiceId || v.voice_id || v.id || v.name).slice(0, 30));
            return;
          }

          const fetched = german.map((v) => {
            const id = v.voiceId || v.voice_id || v.id || v.name;
            const name = v.displayName || v.name || id;
            const gender = (v.gender || '').toLowerCase();
            const tag = gender ? ` — ${gender}` : '';
            return { id, label: `${name}${tag}` };
          });

          // Merge: always-include voices first (Olivia at top), then API voices
          // that aren't duplicates.
          const merged = [...ALWAYS_INCLUDE_VOICES];
          for (const v of fetched) {
            if (!merged.some((m) => m.id === v.id)) merged.push(v);
          }
          GERMAN_VOICES = merged;

          // Migrate selected voice if it's no longer in the list
          if (!GERMAN_VOICES.some((v) => v.id === state.voiceId)) {
            state.voiceId = GERMAN_VOICES[0].id;
            safeStore.set('deutschify:voice', state.voiceId);
            stopSpeaking();
          }
          DEFAULT_VOICE = 'Olivia';

          // Rebuild the voice dropdown with the merged list
          ddVoice = buildVoiceDropdown();
        } catch (e) {
          console.warn('[Voices] fetch failed:', e);
        }
      })();

      // Fullscreen reader mode — toggles body.is-fullscreen
      const fullscreenToggle = $('#fullscreen-toggle');
      function setFullscreen(on) {
        document.body.classList.toggle('is-fullscreen', !!on);
        fullscreenToggle.setAttribute(
          'aria-label',
          on ? 'Exit fullscreen' : 'Enter fullscreen'
        );
        // lang-toggle position changes — re-measure its indicator
        requestAnimationFrame(updateAllIndicators);
      }
      fullscreenToggle.addEventListener('click', () => {
        setFullscreen(!document.body.classList.contains('is-fullscreen'));
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('is-fullscreen')) {
          setFullscreen(false);
        }
      });

      bindRadioGroup('mode', 'mode', updateHeadIfIdle);
      bindRadioGroup('level', 'level', () => {
        updateHeadIfIdle();
        updateSublevelPillIfIdle();
      });
      bindRadioGroup('lang', 'lang', () => {
        safeStore.set('deutschify:lang', state.lang);
        if (state.lang === 'en' && state.session) state.session.usedEnglish = true;
        if (state.lastData) renderBody(state.lastData);
      });
      bindRadioGroup('length', 'length', () => {
        safeStore.set('deutschify:length', state.length);
      });
      bindRadioGroup('register', 'register', () => {
        safeStore.set('deutschify:register', state.register);
      });
      bindRadioGroup('view', 'view', setView);

      // sync initial pressed state for all groups
      syncPressed('lang', state.lang);
      syncPressed('level', state.level);
      syncPressed('length', state.length);
      syncPressed('register', state.register);
      syncPressed('mode', state.mode);
      syncPressed('view', state.view);

      function updateHeadIfIdle() {
        if (state.hasGenerated || state.loading) return;
        cardLevel.textContent = state.level;
        cardMode.textContent = MODE_LABELS[state.mode];
      }

      function updateSublevelPillIfIdle() {
        const sub = getCurrentSublevel(state.level);
        cardSublevel.textContent = sub.name;
        cardSublevel.classList.toggle('sublevel-pill--max', sub.key === 'max');
      }

      function setView(v) {
        const viewChat = document.getElementById('view-chat');
        const viewJournal = document.getElementById('view-journal');
        const VIEWS = { read: viewRead, chat: viewChat, progress: viewProgress, journal: viewJournal };

        // Determine the currently-visible view from DOM, since bindRadioGroup
        // pre-updates state.view.
        let fromView = 'read';
        for (const k of Object.keys(VIEWS)) {
          if (VIEWS[k] && !VIEWS[k].hidden) { fromView = k; break; }
        }
        state.view = v;
        if (fromView === v) return;

        const fromEl = VIEWS[fromView];
        const toEl   = VIEWS[v];
        if (!fromEl || !toEl) return;

        // Fade + slide out
        fromEl.style.transition = 'opacity 180ms ease-in, transform 180ms ease-in';
        fromEl.style.opacity    = '0';
        fromEl.style.transform  = 'translateY(8px)';

        setTimeout(() => {
          fromEl.hidden     = true;
          fromEl.style.cssText = '';

          if (v === 'progress') {
            renderProgressView();
            requestAnimationFrame(() => {
              if (typeof window.__animateProgressView === 'function') {
                window.__animateProgressView();
              }
            });
          }
          if (v === 'chat' && typeof window.__focusChat === 'function') {
            requestAnimationFrame(() => window.__focusChat());
          }
          if (v === 'journal') {
            // Refresh form values + family ribbon when entering Journal
            if (typeof fillProfileForm === 'function') fillProfileForm();
          }

          // Prepare new view above viewport, invisible
          toEl.style.cssText = 'opacity:0;transform:translateY(-8px);transition:none';
          toEl.hidden = false;

          requestAnimationFrame(() => requestAnimationFrame(() => {
            toEl.style.transition = 'opacity 260ms cubic-bezier(0.16,1,0.3,1), transform 260ms cubic-bezier(0.16,1,0.3,1)';
            toEl.style.opacity    = '';
            toEl.style.transform  = '';
            setTimeout(() => { toEl.style.cssText = ''; }, 280);
          }));
        }, 190);
      }

      // initial render ----------------------------------------------------

      function renderStats(opts = {}) {
        const elo = getDerivedElo();
        const { current, next } = getRank(elo);
        $('#rank-name').textContent = current.name;

        if (next) {
          const span = next.min - current.min;
          const inSpan = elo - current.min;
          const pct = Math.max(0, Math.min(100, (inSpan / span) * 100));
          $('#rank-fill').style.width = `${pct}%`;
          $('#rank-hint').textContent = `${next.min - elo} to ${next.name}`;
        } else {
          $('#rank-fill').style.width = '100%';
          $('#rank-hint').textContent = 'Max rank';
        }

        // today
        const today = todayStr();
        const day = state.daily[today] || { texts: 0, xp: 0 };
        $('#today-texts').textContent = String(day.texts);

        // streak
        const streakEl = $('#today-streak');
        if (state.streakLastDate === today && state.streakCurrent > 0) {
          streakEl.textContent = state.streakCurrent === 1
            ? 'day 1'
            : `${state.streakCurrent}d streak`;
          streakEl.classList.add('today__streak--active');
        } else if (state.streakLastDate === dateOffset(1) && state.streakCurrent > 0) {
          streakEl.textContent = `${state.streakCurrent}d, keep it`;
          streakEl.classList.remove('today__streak--active');
        } else {
          streakEl.textContent = 'no streak';
          streakEl.classList.remove('today__streak--active');
        }

        // ELO delta flash
        if (opts.delta && opts.delta > 0) {
          const d = $('#rank-delta');
          d.textContent = `+${opts.delta}`;
          d.classList.remove('rank__delta--show');
          void d.offsetWidth;
          d.classList.add('rank__delta--show');
        }

        // rank-up flash
        if (opts.rankUp) {
          const n = $('#rank-name');
          n.classList.remove('rank__name--up');
          void n.offsetWidth;
          n.classList.add('rank__name--up');
        }

        // top-bar prestige stars per level
        for (const lvl of LEVELS) {
          const el = $(`[data-stars-for="${lvl}"]`);
          if (!el) continue;
          const p = state.levelPrestige[lvl] || 0;
          el.textContent = p > 0 ? '★'.repeat(Math.min(p, 3)) + (p > 3 ? `+${p - 3}` : '') : '';
        }
      }

      renderStats();
      cardLevel.textContent = state.level;
      cardMode.textContent = MODE_LABELS[state.mode];
      updateSublevelPillIfIdle();

      function fillFromTpl(target, tplId) {
        const tpl = document.getElementById(tplId);
        target.innerHTML = '';
        target.appendChild(tpl.content.cloneNode(true));
      }

      function renderEmpty() {
        fillFromTpl(cardBody, 'tpl-empty');
        fillFromTpl(cardFoot, 'tpl-generate-btn');
        $('#generate').addEventListener('click', generate);
        viewRead.classList.add('reader--empty');
      }

      function renderLoading() {
        viewRead.classList.remove('reader--empty');
        requestAnimationFrame(updateAllIndicators);
        if (typeof stopSpeaking === 'function') stopSpeaking();
        fillFromTpl(cardBody, 'tpl-loading');
        fillFromTpl(cardFoot, 'tpl-loading-foot');
        cardTimerSlot.innerHTML = '';

        const sub = getCurrentSublevel(state.level);
        cardLevel.textContent = state.level;
        cardSublevel.textContent = sub.name;
        cardSublevel.classList.toggle('sublevel-pill--max', sub.key === 'max');
        cardMode.textContent = MODE_LABELS[state.mode];
      }

      function renderBody(data) {
        cardBody.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'body-text';

        // Detect dialogue \u2192 left-align (chat-style) instead of centered
        const sourceText = state.lang === 'en' && data.textEnglish ? data.textEnglish : data.text;
        if (sourceText && isDialogue(sourceText)) {
          wrap.classList.add('body-text--dialogue');
        }

        if (state.lang === 'en') {
          if (data.textEnglish && data.textEnglish.trim()) {
            wrap.innerHTML = renderPlainParagraphs(data.textEnglish);
          } else {
            wrap.innerHTML =
              '<p class="lang-fallback">English translation isn\u2019t available for this text.</p>';
          }
        } else {
          wrap.innerHTML = renderTextWithGlossary(data.text, data.glossary);
        }

        cardBody.appendChild(wrap);

        if (state.lang === 'de') attachWordHandlers();
        letterizeText(wrap);
      }

      // Wrap each non-whitespace character in <span class="letter"> with a
      // staggered animation-delay so the text drops in lego-by-lego.
      // Skips text inside .word__tip (tooltips shouldn't animate).
      function letterizeText(container) {
        const textNodes = [];
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (node.parentElement && node.parentElement.closest('.word__tip')) return NodeFilter.FILTER_REJECT;
            if (!node.textContent) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        let n;
        while ((n = walker.nextNode())) textNodes.push(n);

        const totalChars = textNodes.reduce((s, node) => s + node.textContent.length, 0);
        if (totalChars === 0) return;

        // Per-letter delay: snappy for short text, scales down for long so the
        // cascade caps out at ~2.8s end-to-end.
        const speed = totalChars > 200 ? 2800 / totalChars : 14;

        let charIdx = 0;
        for (const textNode of textNodes) {
          const text = textNode.textContent;
          const frag = document.createDocumentFragment();
          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (/\s/.test(ch)) {
              // Spaces stay as plain text nodes \u2014 they don't need animating, and
              // letting them be inline-block causes weird layout glitches.
              frag.appendChild(document.createTextNode(ch));
            } else {
              const span = document.createElement('span');
              span.className = 'letter';
              span.style.setProperty('--d', Math.round(charIdx * speed) + 'ms');
              span.textContent = ch;
              frag.appendChild(span);
            }
            charIdx++;
          }
          textNode.replaceWith(frag);
        }
      }

      function attachWordHandlers() {
        $$('.word', cardBody).forEach((w) => {
          w.addEventListener('click', onWordClick);
          // keyboard equivalents — Enter/Space toggle just like a click
          w.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onWordClick(e);
            }
          });
        });
      }

      // Save / unsave a word via the star inside its tooltip.
      // Uses event delegation on cardBody so it works for newly-rendered words.
      cardBody.addEventListener('click', (e) => {
        const star = e.target.closest('[data-save-word]');
        if (!star) return;
        e.stopPropagation(); // don't bubble to the word's own click (which would toggle tooltip)

        const wordKey = star.dataset.saveWord;
        if (!wordKey) return;
        const wordEl = star.closest('.word');
        const trans = wordEl?.dataset.translation || '';
        const original = wordEl?.dataset.word || wordKey;

        if (state.savedWords[wordKey]) {
          delete state.savedWords[wordKey];
          star.classList.remove('is-saved');
          star.setAttribute('aria-label', 'Save word');
          star.setAttribute('title', 'Save word');
        } else {
          state.savedWords[wordKey] = {
            original,
            trans,
            savedAt: Date.now(),
          };
          star.classList.add('is-saved');
          star.setAttribute('aria-label', 'Remove from saved');
          star.setAttribute('title', 'Remove from saved');
        }
        saveStats();
      });

      function clearActiveWords() {
        $$('.word--active').forEach((w) => w.classList.remove('word--active'));

      // Clamp a word's tooltip bubble within the visible viewport.
      // Called after word--active is set so the tip is rendered and measurable.
      function clampWordTip(wordEl) {
        const tip = wordEl.querySelector('.word__tip');
        if (!tip) return;
        tip.style.cssText = '';
        requestAnimationFrame(() => {
          const r   = tip.getBoundingClientRect();
          const mrg = 8;
          const topbarH = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')
          ) || 56;

          let xShift = 0;
          if (r.left < mrg) {
            xShift = mrg - r.left;
          } else if (r.right > window.innerWidth - mrg) {
            xShift = -(r.right - (window.innerWidth - mrg));
          }
          if (xShift !== 0) {
            tip.style.transform = `translateX(calc(-50% + ${xShift}px))`;
          }

          if (r.top < topbarH + mrg) {
            tip.style.bottom = 'auto';
            tip.style.top    = 'calc(100% + 8px)';
          }
        });
      }

      }

      function onWordClick(e) {
        // Ignore clicks that originated from inside the tooltip (e.g. the star button)
        if (e.target && e.target.closest && e.target.closest('.word__tip')) return;

        // If a long-press just opened the context menu on this word, swallow the
        // synthetic click that browsers fire on touchend. Otherwise the click would
        // immediately toggle the word's active state and the user's gesture feels broken.
        if (longPressFiredFor && longPressFiredFor === e.currentTarget) {
          longPressFiredFor = null;
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          return;
        }

        e.stopPropagation();   // don't trigger the document-level dismiss
        const el = e.currentTarget;
        const wasActive = el.classList.contains('word--active');

        clearActiveWords();
        if (wasActive) return; // second click on the same word toggles off

        el.classList.add('word--active');
        clampWordTip(el);  // keep tooltip within viewport on all screen sizes

        const wordKey = (el.dataset.word || '').trim().toLowerCase();

        // session tracking (no longer surfaced in UI, but used internally for XP)
        if (state.session && wordKey) {
          state.session.totalHovers += 1;
          state.session.uniqueWords.add(wordKey);
        }

        // persistent — used only to feed AI feedback ("words you've struggled with")
        const w = wordKey;
        if (w) {
          state.hoverWords[w] = (state.hoverWords[w] || 0) + 1;
          // throttled save — write at most every few clicks
          state._hoverDirty = (state._hoverDirty || 0) + 1;
          if (state._hoverDirty >= 5) {
            state._hoverDirty = 0;
            saveStats();
          }
        }

        // lazy translation lookup for words the model didn't include
        if (el.classList.contains('word--unknown') && !el.dataset.fetching) {
          el.dataset.fetching = '1';
          el.classList.add('word--loading');
          const tipText = el.querySelector('.word__tip-text');
          if (tipText) tipText.textContent = 'looking up…';
          const ctx = state.lastData?.text || '';
          lookupWord(el.dataset.word || '', ctx).then((t) => {
            if (t) {
              el.dataset.translation = t;
              if (tipText) tipText.textContent = t;
              el.classList.remove('word--unknown', 'word--loading');
            } else {
              el.dataset.translation = '—';
              if (tipText) tipText.textContent = '—';
              el.classList.remove('word--loading');
            }
            delete el.dataset.fetching;
          }).catch(() => {
            el.classList.remove('word--loading');
            if (tipText) tipText.textContent = el.dataset.translation || '—';
            delete el.dataset.fetching;
          });
        }
      }

      function startSession(data) {
        const sub = getCurrentSublevel(state.level);
        state.session = {
          level: state.level,
          subLevelKey: sub.key,
          timed: !!sub.timed,
          wordCount: countWords(data.text),
          totalHovers: 0,
          uniqueWords: new Set(),
          usedEnglish: state.lang === 'en',
          timer: null,
          timerInt: null,
          timerExpired: false,
        };
        if (sub.timed && state.lang === 'de') {
          startTimerIfNeeded(timerSecondsForText(state.session.wordCount));
        }
      }

      function finalizeSession() {
        if (!state.session) return;
        const s = state.session;
        state.session = null;

        if (s.timerInt) {
          window.clearInterval(s.timerInt);
          s.timerInt = null;
        }
        cardTimerSlot.innerHTML = '';

        const xp = computeXp(s);
        const oldElo = getDerivedElo();
        const oldRank = getRank(oldElo).current.name;

        // add to that level's XP, capped at max (excess held until prestige)
        const cap = LEVEL_XP_MAX[s.level];
        state.levelXp[s.level] = Math.min(cap, (state.levelXp[s.level] || 0) + xp);

        state.totalTexts += 1;

        const today = todayStr();
        const day = state.daily[today] || { texts: 0, xp: 0 };
        day.texts += 1;
        day.xp += xp;
        state.daily[today] = day;

        // streak handling
        if (state.streakLastDate !== today) {
          if (state.streakLastDate === dateOffset(1)) state.streakCurrent += 1;
          else state.streakCurrent = 1;
          state.streakLastDate = today;
        }

        const newRank = getRank(getDerivedElo()).current.name;
        const rankUp = newRank !== oldRank;

        pruneDaily();
        if (state.feedback) state.feedback.generatedAt = 0; // mark stale
        saveStats();
        renderStats({ delta: xp, rankUp });
        // sublevel may have advanced — refresh pill if applicable
        updateSublevelPillIfIdle();
      }

      function renderArticle(data) {
        viewRead.classList.remove('reader--empty');
        requestAnimationFrame(updateAllIndicators);
        renderBody(data);
        maybeRenderChatReply(data);

        cardLevel.textContent = state.level;
        const sub = getCurrentSublevel(state.level);
        cardSublevel.textContent = sub.name;
        cardSublevel.classList.toggle('sublevel-pill--max', sub.key === 'max');

        cardMode.textContent = (data.title && data.title.trim())
          ? trimTitle(data.title)
          : MODE_LABELS[state.mode];

        fillFromTpl(cardFoot, 'tpl-next-row');
        $('#next').addEventListener('click', generate);

        startSession(data);

        requestAnimationFrame(() => {
          $('#next')?.focus({ preventScroll: true });
        });
      }

      // ─────────────── CHAT-BACK MODE ─────────────────
      // When mode is 'chat', append a textarea + submit button under the
      // generated opener. On submit, evaluate the user's reply and show a
      // 1-10 score + one-sentence kind+honest feedback.
      function maybeRenderChatReply(data) {
        if (state.mode !== 'chat') return;
        const p = getActiveProfile() || { name: 'You', avatar: null };
        const initial = (p.name || 'U').trim()[0]?.toUpperCase() || 'U';
        const avatarStyle = p.avatar
          ? `background-image:url(${p.avatar});background-size:cover;background-position:center`
          : '';
        const avatarInner = p.avatar ? '' : escapeHtml(initial);

        const wrap = document.createElement('div');
        wrap.className = 'chat-reply';
        wrap.innerHTML =
          `<div class="chat-reply__compose">` +
            `<div class="chat-reply__avatar" style="${avatarStyle}">${avatarInner}</div>` +
            `<textarea class="chat-reply__textarea" id="chat-reply-input" rows="3"` +
              ` placeholder="Antworte auf Deutsch — schreib einfach, was du sagen würdest."` +
              ` autocomplete="off" spellcheck="false"></textarea>` +
          `</div>` +
          `<div class="chat-reply__row">` +
            `<span class="chat-reply__hint">⌘/Ctrl+Enter to send</span>` +
            `<button type="button" class="chat-reply__submit" id="chat-reply-send">Send reply</button>` +
          `</div>`;
        cardBody.appendChild(wrap);

        const ta = $('#chat-reply-input');
        const btn = $('#chat-reply-send');

        const submit = async () => {
          const reply = (ta.value || '').trim();
          if (!reply) return;
          btn.disabled = true;
          btn.textContent = 'Checking…';
          try {
            const evalResult = await evaluateChatReply(data.text || '', data.textEnglish || '', reply);
            renderChatEvaluation(wrap, evalResult);
          } catch (e) {
            console.error('[Chat] evaluation failed:', e);
            renderChatEvaluation(wrap, {
              score: null,
              feedback: 'Couldn\'t reach the AI to grade your reply — try again in a sec.',
            });
          }
        };

        btn.addEventListener('click', submit);
        ta.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        });

        requestAnimationFrame(() => ta.focus({ preventScroll: true }));
      }

      function renderChatEvaluation(wrap, ev) {
        const score = (typeof ev.score === 'number') ? Math.max(1, Math.min(10, Math.round(ev.score))) : null;
        const feedback = ev.feedback || 'No feedback available.';
        const scoreLabels = ['—', 'tough start', 'getting there', 'okay', 'decent', 'solid', 'good', 'really good', 'great', 'excellent', 'native-level'];
        const label = score != null ? scoreLabels[score] : '';
        const evDiv = document.createElement('div');
        evDiv.className = 'chat-eval';
        evDiv.innerHTML =
          `<div class="chat-eval__head">` +
            (score != null
              ? `<div><span class="chat-eval__score">${score}</span><span class="chat-eval__score-suffix"> / 10</span></div>`
              : `<div class="chat-eval__label">Result</div>`) +
            (label ? `<span class="chat-eval__label">${escapeHtml(label)}</span>` : '') +
          `</div>` +
          `<p class="chat-eval__feedback">${escapeHtml(feedback)}</p>`;
        wrap.appendChild(evDiv);
      }

      // Send the user's reply to DeepSeek for grading. Returns { score, feedback }.
      async function evaluateChatReply(openerDe, openerEn, userReply) {
        const profileBlurb = buildProfileSection() || '';
        const sys = `You are a kind but honest German language coach. The learner just received a casual German message and replied in German. ` +
          `Score their reply 1-10 (10 = native-level natural German, 1 = barely intelligible). ` +
          `Give ONE single-sentence piece of feedback: be encouraging but identify the most useful thing to fix. ` +
          `Return ONLY a JSON object: {"score": <int 1-10>, "feedback": "<one sentence>"}.`;

        const user = [
          'Original message (German): ' + openerDe,
          openerEn ? 'Original message (English): ' + openerEn : '',
          'Learner level: ' + state.level + ' — ' + (LEVEL_GUIDE[state.level] || ''),
          'Learner reply (German): ' + userReply,
          profileBlurb,
        ].filter(Boolean).join('\n');

        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 30000);
        try {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: MODEL,
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: user },
              ],
              temperature: 0.5,
              response_format: { type: 'json_object' },
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const json = await res.json();
          const content = json.choices?.[0]?.message?.content || '{}';
          const parsed = parseJson(content);
          return {
            score: typeof parsed.score === 'number' ? parsed.score : null,
            feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'No feedback available.',
          };
        } finally {
          clearTimeout(timeoutId);
        }
      }

      function trimTitle(s) {
        return s.replace(/[.!?]+$/, '').trim().slice(0, 48);
      }

      function renderError(err) {
        viewRead.classList.remove('reader--empty');
        cardBody.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'error';
        const t = document.createElement('p');
        t.className = 'error__title';
        t.textContent = err instanceof ApiError
          ? `Couldn't reach DeepSeek (${err.status || 'no status'})`
          : 'Something went wrong';
        const d = document.createElement('p');
        d.className = 'error__detail';
        d.textContent = (err && err.detail) || (err && err.message) || 'Try again in a moment.';
        wrap.append(t, d);
        cardBody.appendChild(wrap);

        // recover button
        cardFoot.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-primary';
        btn.textContent = 'Try again';
        btn.addEventListener('click', generate);
        cardFoot.appendChild(btn);
      }

      // generate -----------------------------------------------------------

      async function generate() {
        if (state.loading) return;

        // finalize previous session BEFORE starting a new one
        finalizeSession();

        // if user is on Progress tab, snap back to Read so they see the generation
        if (state.view !== 'read') {
          state.view = 'read';
          syncPressed('view', 'read');
          viewRead.hidden = false;
          viewProgress.hidden = true;
        }

        state.loading = true;
        renderLoading();

        try {
          let data = await callApi(state.mode, state.level, state.length, state.register);
          // ensure every word can be hovered: fill any missing glossary entries
          data = await fillGlossary(data);
          state.lastData = data;
          state.hasGenerated = true;
          renderArticle(data);
          renderStats();
        } catch (err) {
          console.error(err);
          renderError(err);
        } finally {
          state.loading = false;
        }
      }

      // keyboard ------------------------------------------------------------

      document.addEventListener('keydown', (e) => {
        if (state.loading) return;
        if (isInTextField(e.target)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          generate();
        } else if (e.key === 'r' || e.key === 'R') {
          if (state.hasGenerated) {
            e.preventDefault();
            generate();
          }
        }
      });

      function isInTextField(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
      }

      // api -----------------------------------------------------------------

      const SYSTEM_PROMPT = `You generate German language-learning content that sounds like a REAL person living in Germany or Austria today — not a textbook.

Output ONLY a single JSON object. No markdown fences. No commentary before or after.

Schema:
{
  "title": "<2-4 word English label describing this specific text>",
  "text": "<the German content>",
  "textEnglish": "<the same content as natural, idiomatic English. NOT a literal word-for-word translation — write fluent English that conveys the same meaning, tone, and register. Preserve any A:/B: speaker labels and line breaks from the German.>",
  "glossary": {
    "<exact German word as it appears in text>": "<short English translation, 1-3 words>"
  }
}

VOICE — this is the most important rule:
- Write content the learner will ACTUALLY hear, send, or say in real life. Modern, lived, specific.
- Use a real emotional register: mild annoyance, dry humor, excitement, awkwardness, tiredness, curiosity — not sterile neutrality.
- RESPECT the requested formality register:
  - "casual": du / euch, contractions, fillers (echt, halt, naja, irgendwie, ne?), texting tone. Friend-to-friend, family, flatmates, casual coworkers.
  - "formal": Sie / Ihnen, full forms, polite vocab, no slang. Customer service, government, business email, official letter, addressing strangers / elders / Beamte.
  - For dialogues: BOTH speakers use the same register unless the context demands a mismatch (e.g., a Beamter speaking formal Sie to a frustrated du-using customer is fine).
- Anchor in real cultural reality where appropriate: WG-Leben, Anmeldung beim Bürgeramt, Pfand, Sonntag (everything closed), U-Bahn / S-Bahn / Deutsche Bahn delays, Hausmeister, GEZ-Gebühren, Bahncard, Müll-Trennung, paying cash at the Bäckerei, EC-Karte issues, Bürokratie, Mittagspause, Feierabend, Späti, Rewe / Edeka / Aldi / Lidl, Kindergarten-Anmeldung, Termin warten, Schrebergarten.
- Concrete > abstract. Use real place names, real brands, real times of day, real weather, named people. "Ich war gestern bei Edeka" beats "ich war im Supermarkt".
- AVOID textbook openings — never start with "Hallo, ich heiße…" or "Wie geht es dir?". Start in the middle of a real moment.
- AVOID generic topics ("my hobbies", "my family", "the weather is nice today"). Pick a SPECIFIC moment with stakes, even small ones: a missed train, a frustrating Termin, a weird DM, a roommate not buying toilet paper, a Paket that vanished.
- Slang, fillers, and modern expressions are welcome at higher levels: "echt jetzt?", "naja", "halt", "irgendwie", "ne?", "krass", "ach komm", "Mist", "voll nervig", "läuft", "passt schon".

CRITICAL — glossary MUST be complete:
- Include EVERY single German word that appears in "text". Every noun, verb, adjective, adverb, preposition, article, pronoun, conjunction, particle.
- Include common short words too: "ist", "der", "die", "das", "ein", "eine", "ich", "du", "und", "in", "zu", "auf", "auch", "nicht", "mit", "es", etc. NO exceptions.
- Match the EXACT word form as it appears in "text", including capitalization (German nouns are always capitalized) and inflection. Use the surface form, not the lemma.
- If the same word appears multiple times, only one entry is needed.
- Skip ONLY pure punctuation tokens.

GLOSSARY VALUE FORMAT — include lemma + grammar tag for inflected forms:
- Dictionary-form words: just the meaning. Example: "Haus" → "house"
- Inflected verbs: include lemma + tense tag in parens. Examples:
  - "ging" → "went (gehen, Prät.)"
  - "habe gemacht" — handle each token: "habe" → "have (haben, Präs. 1.Sg.)", "gemacht" → "done (machen, Pf.)"
  - "möchte" → "would like (mögen, Konj. II)"
- Plural nouns: "Häuser" → "houses (Haus, Pl.)"
- Declined adjectives: "rotem" → "red (rot, dat.)"
- Articles in non-nominative case: "den" → "the (m. Akk.)"
- Common short words (der, die, ich, und, ist, etc.): just the meaning, no extra info.
- Grammar abbreviations: Prät. (Präteritum), Pf. (Perfekt), Inf., Pl., Sg., Nom./Akk./Dat./Gen., Konj. II, m./f./n., Präs. (Präsens).
- Keep entries concise — under ~8 words per value.

Other rules:
- "text" is natural, idiomatic German appropriate to the requested level AND difficulty band.
- "textEnglish" mirrors "text" line-by-line and paragraph-by-paragraph so a learner can compare structure.
- Keep glossary translations short (1-3 words), contextual to how the word is used here.
- Use real German, no transliteration.
- For dialogue mode: prefix each line with "A:" or "B:" followed by a space, with newlines between lines, in BOTH "text" and "textEnglish".`;

      const LEVEL_GUIDE = {
        A1: 'Absolute beginner. Simple present tense only. Basic vocabulary (haben, sein, machen, gehen, common nouns). Very short sentences. No subjunctive, no Genitiv. Voice: pick ONE concrete real-life moment — train is late, forgot keys, raining again, missing milk, bag is heavy, late for class. Direct, factual, specific. NEVER "Hello my name is Anna".',
        A2: 'Elementary. Present and Perfekt past tense. Everyday vocabulary. Modal verbs (können, müssen, wollen). Simple subordinate clauses with weil/dass. Voice: small frustrations, plans with friends, requests, complaints — the way someone actually texts a friend or talks to a flatmate.',
        B1: 'Intermediate. Comfortable with Präteritum, Konjunktiv II for hypotheticals, broader vocabulary, opinions, plans. More complex sentence structure. Voice: opinions, mild complaints, weekend retellings, slight slang welcome ("eigentlich", "echt", "halt", "ja schon", "irgendwie"). Reference real German cultural details (Anmeldung, Pfand, WG, Hausmeister, GEZ, Termin).',
        B2: 'Upper intermediate. Passive voice, nuanced topics (work, society, abstract ideas), idioms, complex multi-clause sentences. Genitiv usage. Voice: real opinions and reactions, dry humor, bureaucratic frustration, work talk, social commentary. Idioms welcome ("auf den Keks gehen", "die Nase voll haben", "auf die Schippe nehmen", "den Faden verlieren").',
        C1: 'Advanced. Sophisticated vocabulary, abstract or specialized topics, complex grammar including extended attributes, varied registers, subtle connotation. Voice: nuanced, layered, with dry irony, regional flavor, modern colloquialisms where natural ("krass", "gönn dir", "naja", "ach komm"). Opinionated and specific — the way a fluent native actually speaks.',
      };

      const MODE_INSTRUCTIONS = {
        daily:
          'Generate ONE line of REAL daily German — what a person actually says or texts to a friend, flatmate, family member, coworker, or stranger today. EITHER a single natural utterance, OR a short 3-6 line A:/B: dialogue. Anchor in a SPECIFIC concrete moment with small stakes: late U-Bahn, missing Pfand bottles, WG drama (dishwasher, toilet paper, loud neighbour), weekend plans, Lieferando order, awkward Anmeldung-Termin, weather complaint, Kasse only takes cash, package vanished, DHL note on the door, Hausmeister fixed nothing, group chat plans, Sunday and everything closed, Mensa was disgusting, Bahn delayed again. Modern situations: dating apps, group chats, streaming, gaming, food delivery, work-from-home. Skip generic openings — drop the reader into the middle of the moment.',
        school:
          'Generate ONE realistic school/uni-context line in German — what a student would actually face: a teacher question in class, a homework prompt, a peer asking for help in the group chat, a study-plan message, a complaint about a Klausur or a Lehrer, a reminder about a Referat. Specific subject (Mathe, Bio, Geschichte, Deutsch, Englisch, Sozialkunde, Physik, Ethik, Sport, Musik) and grade-appropriate. Realistic problem framing — not "what color is the apple". Could also be university register (Vorlesung, Seminar, Hausarbeit, Klausur, ECTS, Prof, Tutor, Mensa, WG-Kasten Bier).',
        story:
          'Generate a short PERSONAL anecdote in German — something that actually happened to the narrator (or a friend / coworker / family member). Past tense (Perfekt for spoken feel). MODERN setting (today, this week, last month — never historical or fairy-tale). The kind of story you tell at dinner: a Bürokratie disaster, a delayed-train odyssey, an awkward date, a missing package adventure, a Hausmeister encounter, a Sunday-shopping crisis, a flatmate problem, a job-interview slip-up, a misread DM, a wrong Bestellung. Specific real names: Späti, Rewe, S-Bahn, Friedrichshain, München, Hofbräuhaus, Karstadt. Specific times. End with a small reaction or punchline ("naja, war halt so", "echt nervig", "wenigstens lustig"), NOT "and so I learned my lesson".',
        chat:
          'Generate ONE short conversational opener that a real German friend / family member / coworker / stranger might genuinely say or text — something that INVITES a response from the learner. Could be: a casual question, a small piece of news, a complaint they\'re venting, a plan they\'re proposing, a reaction to something. The learner will type a reply in German next. Keep it ONE message (no A:/B: dialogue), inviting and natural. The text should be a single sentence or two that the learner can answer.',
      };

      // Length targets per mode — tuned to feel like a real "short / medium / long" range
      const LENGTH_HINTS = {
        daily:  { short: '1-2 sentences OR a 2-3 line dialogue (~15-25 words total)', medium: '3-5 sentences OR a 4-6 line dialogue (~40-70 words total)', long: '6-8 sentences OR a 7-10 line dialogue (~90-140 words total)' },
        school: { short: '1 sentence (~12-18 words)',                                 medium: '2-3 sentences (~30-45 words)',                              long: '4-5 sentences (~70-90 words)' },
        story:  { short: '3-4 sentences (~50-70 words)',                              medium: '5-7 sentences (~100-140 words)',                            long: '9-12 sentences (~200-260 words)' },
        chat:   { short: '1 short sentence (~8-12 words)',                            medium: '1-2 sentences (~15-25 words)',                              long: '2-3 sentences (~30-45 words)' },
      };

      const REGISTER_HINTS = {
        casual: 'casual — use du/euch, contractions, fillers, texting tone',
        formal: 'formal — use Sie/Ihnen, full forms, polite/professional vocab, no slang',
      };

      // Build a "PERSONAL CONTEXT" block from the active profile so the AI
      // can pick situations/topics/angles that fit THIS specific learner's life.
      function buildProfileSection() {
        const p = getActiveProfile();
        if (!p) return '';
        const fields = [];
        if (p.name)        fields.push('- Name: ' + p.name);
        if (p.age)         fields.push('- Age: ' + p.age);
        if (p.occupation)  fields.push('- Occupation/role: ' + p.occupation);
        if (p.hobbies)     fields.push('- Hobbies & interests: ' + p.hobbies);
        if (p.location)    fields.push('- Where they live / are going: ' + p.location);
        if (p.goals)       fields.push('- Why they\'re learning German: ' + p.goals);
        // weakAreas is a free-form string (used to be a chip array — migrated on load).
        const weakText = (typeof p.weakAreas === 'string')
          ? p.weakAreas.trim()
          : (Array.isArray(p.weakAreas)
              ? p.weakAreas.map((id) => {
                  const w = (typeof WEAK_AREAS !== 'undefined') ? WEAK_AREAS.find((x) => x.id === id) : null;
                  return w ? w.label : id;
                }).join(', ')
              : '');
        if (weakText) fields.push('- Wants to practice / get better at: ' + weakText);
        if (fields.length === 0) return '';
        return [
          '',
          'PERSONAL CONTEXT — this learner is a real person. Use this to pick a topic / angle / situation that ACTUALLY fits their day-to-day life. Don\'t name them in third person, just write the kind of content they\'d genuinely encounter:',
          fields.join('\n'),
          'When their "wants to practice" list above mentions specific grammar, lean into that grammar naturally in the text without making it feel like an exercise.',
        ].join('\n');
      }

      function buildUserPrompt(mode, level, sub, length, register) {
        const lenHint = (LENGTH_HINTS[mode] && LENGTH_HINTS[mode][length]) || '';
        const regHint = REGISTER_HINTS[register] || REGISTER_HINTS.casual;

        // Pick up to 5 saved words at random to encourage natural resurfacing
        const savedKeys = Object.keys(state.savedWords || {});
        let savedHint = '';
        if (savedKeys.length > 0) {
          const shuffled = savedKeys.slice().sort(() => Math.random() - 0.5);
          const picks = shuffled.slice(0, Math.min(5, shuffled.length))
            .map((k) => state.savedWords[k].original || k);
          savedHint = `\n\nThe learner is actively studying these German words — try to naturally include 1-2 of them in your text where they FIT the context. Do NOT force any if they don't fit: ${picks.join(', ')}.`;
        }

        return [
          `Mode: ${mode}`,
          `Level: ${level} — ${LEVEL_GUIDE[level]}`,
          `Difficulty band within ${level}: ${sub.name} — ${SUB_HINT[sub.key]}`,
          lenHint ? `Length: ${lenHint}` : '',
          `Register: ${regHint}`,
          '',
          MODE_INSTRUCTIONS[mode],
          '',
          'Anchor this in a SPECIFIC concrete moment with small real-life stakes. Use real names, real places, real situations a learner would actually encounter today in Germany or Austria. NO textbook-style openings, NO generic topics. Pick a fresh angle different from your last generations.' + savedHint,
          buildProfileSection(),
        ].filter(Boolean).join('\n');
      }

      class ApiError extends Error {
        constructor(message, status, detail) {
          super(message);
          this.status = status;
          this.detail = detail;
        }
      }

      async function callApi(mode, level, length, register) {
        const sub = getCurrentSublevel(level);
        const body = {
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(mode, level, sub, length, register) },
          ],
          temperature: 1.05,
          response_format: { type: 'json_object' },
        };

        // Hard timeout — DeepSeek occasionally hangs; never let the UI stick on "Generating..." forever.
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 60000);

        let res;
        try {
          res = await fetch(API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (e) {
          clearTimeout(timeoutId);
          if (e && e.name === 'AbortError') {
            throw new ApiError('Generation timed out', 0, 'Took longer than 60s — the AI server is slow or down. Try again.');
          }
          throw new ApiError('Network request failed', 0, e.message || 'Check your connection.');
        }
        clearTimeout(timeoutId);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ApiError(`API responded with ${res.status}`, res.status, text.slice(0, 360));
        }

        const json = await res.json();
        const content = json.choices?.[0]?.message?.content;
        if (!content) {
          throw new ApiError('Empty response from API.', 0, JSON.stringify(json).slice(0, 360));
        }

        const parsed = parseJson(content);
        validateShape(parsed);
        return parsed;
      }

      function parseJson(content) {
        const stripped = content.trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '');
        try { return JSON.parse(stripped); } catch (_) {}
        const match = stripped.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch (_) {}
        }
        throw new ApiError('Could not parse the API response as JSON.', 0, content.slice(0, 280));
      }

      function validateShape(obj) {
        if (!obj || typeof obj !== 'object') throw new ApiError('Bad response shape.', 0, '');
        if (typeof obj.text !== 'string' || !obj.text.trim()) {
          throw new ApiError('Response missing "text".', 0, JSON.stringify(obj).slice(0, 280));
        }
        if (!obj.glossary || typeof obj.glossary !== 'object') obj.glossary = {};
        if (typeof obj.textEnglish !== 'string') obj.textEnglish = '';
      }

      // tokenize + render --------------------------------------------------

      const WORD_CHAR = /[A-Za-zÄÖÜäöüß]/;
      const WORD_RE = /[A-Za-zÄÖÜäöüß]+|[^A-Za-zÄÖÜäöüß]+/g;

      function renderTextWithGlossary(rawText, glossary) {
        const lookup = new Map();
        for (const [k, v] of Object.entries(glossary || {})) {
          if (typeof k !== 'string' || typeof v !== 'string') continue;
          const trans = v.trim();
          if (!trans) continue;
          const key = k.trim().toLowerCase();
          if (key && !lookup.has(key)) lookup.set(key, trans);
        }

        const paragraphs = rawText
          .split(/\n{1,}/)
          .map((p) => p.trim())
          .filter(Boolean);

        return paragraphs.map((p) => `<p>${tokensToHtml(p, lookup)}</p>`).join('');
      }

      function renderPlainParagraphs(rawText) {
        const paragraphs = rawText
          .split(/\n{1,}/)
          .map((p) => p.trim())
          .filter(Boolean);

        return paragraphs.map((p) => {
          const m = p.match(/^([A-Z]):\s+/);
          if (m) {
            return `<p>${speakerAvatarHtml(m[1])}${escapeHtml(p.slice(m[0].length))}</p>`;
          }
          return `<p>${escapeHtml(p)}</p>`;
        }).join('');
      }

      // Free DiceBear avatars (MIT-licensed) — deterministic per seed.
      // 'Mia' typically renders female-presenting, 'Lukas' male-presenting.
      const SPEAKER_AVATAR_SEEDS = { A: 'Mia', B: 'Lukas', C: 'Greta', D: 'Anton' };
      function speakerAvatarUrl(letter) {
        const seed = SPEAKER_AVATAR_SEEDS[letter] || letter || 'Anonymous';
        return `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(seed)}&radius=50&backgroundColor=2c2d31`;
      }
      function speakerAvatarHtml(letter) {
        return `<img class="speaker-avatar" src="${speakerAvatarUrl(letter)}" alt="${escapeAttr(letter)}" />`;
      }

      // SVG markup for star icons inside the tooltip
      const STAR_OUTLINE_SVG = '<svg class="icon-star" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 9.95 5.7l4.3.62-3.12 3.04.74 4.3L8 11.6l-3.85 2.04.74-4.3L1.75 6.32l4.3-.62z"/></svg>';
      const STAR_FILLED_SVG = '<svg class="icon-star-filled" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 1.8 9.95 5.7l4.3.62-3.12 3.04.74 4.3L8 11.6l-3.85 2.04.74-4.3L1.75 6.32l4.3-.62z"/></svg>';

      function buildWordHtml(tok, trans) {
        const wordKey = tok.toLowerCase();
        const cls = trans ? 'word' : 'word word--unknown';
        const transText = trans || '—';
        const isSaved = !!state.savedWords[wordKey];
        const starCls = 'word__tip-star' + (isSaved ? ' is-saved' : '');
        const starLabel = isSaved ? 'Remove from saved' : 'Save word';
        return (
          `<span class="${cls}" tabindex="0" data-word="${escapeAttr(tok)}" data-translation="${escapeAttr(transText)}">` +
            escapeHtml(tok) +
            `<span class="word__tip" role="tooltip">` +
              `<span class="word__tip-text">${escapeHtml(transText)}</span>` +
              `<button type="button" class="${starCls}" data-save-word="${escapeAttr(wordKey)}" aria-label="${starLabel}" title="${starLabel}">` +
                STAR_OUTLINE_SVG + STAR_FILLED_SVG +
              `</button>` +
            `</span>` +
          `</span>`
        );
      }

      function tokensToHtml(text, lookup) {
        // detect speaker label at start of line (A: or B:)
        const speakerMatch = text.match(/^([A-Z]):\s+/);
        let prefix = '';
        let body = text;
        if (speakerMatch) {
          prefix = speakerAvatarHtml(speakerMatch[1]);
          body = text.slice(speakerMatch[0].length);
        }

        const tokens = body.match(WORD_RE) || [];
        let out = '';
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (WORD_CHAR.test(tok[0])) {
            const trans = lookup.get(tok.toLowerCase());
            // Look ahead — if the next token starts with non-space punctuation
            // (?, !, ., ,, ;, :, ", ', etc.), glue it to this word so it
            // never wraps to the next line on its own.
            let trailingPunct = '';
            if (i + 1 < tokens.length) {
              const next = tokens[i + 1];
              const punctMatch = next.match(/^[^\sA-Za-zÄÖÜäöüß]+/);
              if (punctMatch) {
                trailingPunct = punctMatch[0];
                tokens[i + 1] = next.slice(punctMatch[0].length);
              }
            }
            const wordHtml = buildWordHtml(tok, trans);
            if (trailingPunct) {
              out += `<span class="word-group">${wordHtml}${escapeHtml(trailingPunct)}</span>`;
            } else {
              out += wordHtml;
            }
          } else if (tok.length > 0) {
            out += escapeHtml(tok);
          }
        }
        return prefix + out;
      }

      function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function escapeAttr(s) {
        return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      // timer -------------------------------------------------------------

      function startTimerIfNeeded(seconds) {
        if (!state.session) return;
        state.session.timer = { startTs: Date.now(), duration: seconds * 1000 };
        state.session.timerExpired = false;
        renderTimerPill();
        state.session.timerInt = window.setInterval(updateTimer, 250);
      }

      function renderTimerPill() {
        cardTimerSlot.innerHTML = `
          <span class="timer-pill" id="timer-pill">
            <span class="timer-pill__dot" aria-hidden="true"></span>
            <span class="timer-pill__time">--:--</span>
          </span>`;
        updateTimer();
      }

      function updateTimer() {
        const s = state.session;
        if (!s || !s.timer) return;
        const pill = $('#timer-pill');
        if (!pill) return;
        const timeEl = pill.querySelector('.timer-pill__time');
        const elapsed = Date.now() - s.timer.startTs;
        const remaining = Math.max(0, Math.ceil((s.timer.duration - elapsed) / 1000));

        if (remaining === 0 && !s.timerExpired) {
          s.timerExpired = true;
          pill.classList.add('timer-pill--expired');
          if (timeEl) timeEl.textContent = "time's up";
          if (s.timerInt) {
            window.clearInterval(s.timerInt);
            s.timerInt = null;
          }
        } else if (!s.timerExpired) {
          const m = Math.floor(remaining / 60);
          const sec = remaining % 60;
          if (timeEl) timeEl.textContent = `${m}:${String(sec).padStart(2, '0')}`;
        }
      }

      // glossary fill — second API call to ensure every word is hoverable

      async function fillGlossary(data) {
        const have = new Set(Object.keys(data.glossary || {}).map((k) => k.trim().toLowerCase()));
        const missing = new Set();
        const tokens = data.text.match(WORD_RE) || [];
        for (const tok of tokens) {
          if (WORD_CHAR.test(tok[0]) && !have.has(tok.toLowerCase())) missing.add(tok);
        }
        if (missing.size === 0) return data;
        const list = Array.from(missing).slice(0, 80);

        try {
          const body = {
            model: MODEL,
            messages: [
              {
                role: 'system',
                content: 'You translate German words to English in context. Output ONLY a JSON object mapping each given German word (in the form provided) to a short English translation (1-3 words). No commentary.',
              },
              {
                role: 'user',
                content: `Context (German):\n${data.text}\n\nWords to translate (preserve their exact form as keys): ${list.join(', ')}\n\nReturn JSON: {"<word>": "<english>", ...}`,
              },
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' },
          };
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return data;
          const json = await res.json();
          const content = json.choices?.[0]?.message?.content;
          if (!content) return data;
          const parsed = parseJson(content);
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && v.trim()) data.glossary[k] = v.trim();
            }
          }
        } catch (_) {}
        return data;
      }

      // single-word lazy lookup (last resort if both calls miss it)

      const wordCache = new Map();

      async function lookupWord(word, context) {
        const key = word.toLowerCase();
        if (wordCache.has(key)) return wordCache.get(key);
        try {
          const body = {
            model: MODEL,
            messages: [
              { role: 'system', content: 'You translate one German word to English given a sentence context. Reply with ONLY the English meaning, 1-3 words. No quotes, no preamble.' },
              { role: 'user', content: `Word: ${word}\nContext: ${context.slice(0, 400)}` },
            ],
            temperature: 0.2,
          };
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return '';
          const json = await res.json();
          const t = (json.choices?.[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '');
          wordCache.set(key, t);
          return t;
        } catch (_) { return ''; }
      }

      // progress view ----------------------------------------------------

      function renderProgressView() {
        progressHost.innerHTML = '';

        const view = document.createElement('div');
        view.className = 'progress-view';

        const elo = getDerivedElo();
        const rank = getRank(elo);
        const today = state.daily[todayStr()] || { texts: 0 };

        // head
        const head = document.createElement('div');
        head.className = 'progress-view__head';
        const sub = state.totalTexts === 0
          ? 'No texts yet — generate your first to start tracking.'
          : `${state.totalTexts} text${state.totalTexts === 1 ? '' : 's'} read across all levels.`;
        head.innerHTML = `
          <h2 class="progress-view__title">Your German <em>journey</em></h2>
          <p class="progress-view__subtitle">${escapeHtml(sub)}</p>
        `;
        view.appendChild(head);

        // stat cards
        const dash = document.createElement('div');
        dash.className = 'dash-grid';
        const nextRank = rank.next ? `${rank.next.min - elo} to ${escapeHtml(rank.next.name)}` : 'Maximum rank';
        dash.innerHTML = `
          <div class="stat-card">
            <p class="stat-card__label">Rank</p>
            <p class="stat-card__value stat-card__value--accent">${escapeHtml(rank.current.name)}</p>
            <p class="stat-card__detail">${nextRank}</p>
          </div>
          <div class="stat-card">
            <p class="stat-card__label">Total ELO</p>
            <p class="stat-card__value">${elo}</p>
            <p class="stat-card__detail">Across all levels</p>
          </div>
          <div class="stat-card">
            <p class="stat-card__label">Today</p>
            <p class="stat-card__value">${today.texts}</p>
            <p class="stat-card__detail">${today.texts === 1 ? 'text read' : 'texts read'}</p>
          </div>
        `;
        view.appendChild(dash);

        view.appendChild(buildGraphCard());
        view.appendChild(buildSavedWordsCard());
        view.appendChild(buildMasteryList());
        view.appendChild(buildFeedbackCard());

        progressHost.appendChild(view);

        attachProgressEvents();

        const hasContent = state.totalTexts > 0 || Object.keys(state.hoverWords).length > 0;
        const isStale = !state.feedback.sentence || (Date.now() - state.feedback.generatedAt > 30 * 60 * 1000);
        if (hasContent && isStale) refreshFeedback(false);
      }

      function buildGraphCard() {
        const card = document.createElement('div');
        card.className = 'graph-card';
        const head = document.createElement('div');
        head.className = 'graph-card__head';
        head.innerHTML = `<p class="graph-card__title">ELO over time</p><span class="graph-card__period">last 30 days</span>`;
        card.appendChild(head);

        // cumulative ELO from daily.xp
        const sortedDays = Object.keys(state.daily).sort();
        let cum = 0;
        const cumByDay = {};
        for (const d of sortedDays) {
          cum += (state.daily[d].xp || 0);
          cumByDay[d] = cum;
        }

        if (cum === 0) {
          const empty = document.createElement('div');
          empty.className = 'graph-empty';
          empty.textContent = 'Generate some texts to start tracking your progress.';
          card.appendChild(empty);
          return card;
        }

        const points = [];
        let last = 0;
        for (let i = 29; i >= 0; i--) {
          const d = dateOffset(i);
          if (cumByDay[d] !== undefined) last = cumByDay[d];
          points.push({ d, e: last });
        }

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'graph-svg');
        svg.setAttribute('viewBox', '0 0 600 140');
        svg.setAttribute('preserveAspectRatio', 'none');

        const W = 600, H = 140, padL = 38, padR = 8, padT = 10, padB = 24;
        const innerW = W - padL - padR;
        const innerH = H - padT - padB;

        const maxE = Math.max(...points.map((p) => p.e), 10);
        const xStep = innerW / Math.max(1, points.length - 1);

        for (let i = 0; i <= 3; i++) {
          const y = padT + (innerH * i) / 3;
          const v = Math.round(maxE - (maxE * i) / 3);
          const line = document.createElementNS(svgNs, 'line');
          line.setAttribute('class', 'grid-line');
          line.setAttribute('x1', padL);
          line.setAttribute('x2', W - padR);
          line.setAttribute('y1', y);
          line.setAttribute('y2', y);
          svg.appendChild(line);

          const text = document.createElementNS(svgNs, 'text');
          text.setAttribute('class', 'axis-text');
          text.setAttribute('x', padL - 6);
          text.setAttribute('y', y + 3);
          text.setAttribute('text-anchor', 'end');
          text.textContent = String(v);
          svg.appendChild(text);
        }

        const xLabels = ['30d ago', '15d', 'today'];
        xLabels.forEach((label, idx) => {
          const x = padL + (innerW * idx) / 2;
          const text = document.createElementNS(svgNs, 'text');
          text.setAttribute('class', 'axis-text');
          text.setAttribute('x', x);
          text.setAttribute('y', H - 6);
          text.setAttribute('text-anchor', idx === 0 ? 'start' : (idx === 2 ? 'end' : 'middle'));
          text.textContent = label;
          svg.appendChild(text);
        });

        const coords = points.map((p, i) => [
          padL + i * xStep,
          padT + innerH * (1 - p.e / maxE),
        ]);

        const linePath = coords
          .map((c, i) => (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1))
          .join(' ');
        const baseY = padT + innerH;
        const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${baseY.toFixed(1)} L${coords[0][0].toFixed(1)},${baseY.toFixed(1)} Z`;

        const area = document.createElementNS(svgNs, 'path');
        area.setAttribute('class', 'area');
        area.setAttribute('d', areaPath);
        svg.appendChild(area);

        const line = document.createElementNS(svgNs, 'path');
        line.setAttribute('class', 'line');
        line.setAttribute('d', linePath);
        svg.appendChild(line);

        const lastCoord = coords[coords.length - 1];
        const dot = document.createElementNS(svgNs, 'circle');
        dot.setAttribute('class', 'dot');
        dot.setAttribute('cx', lastCoord[0]);
        dot.setAttribute('cy', lastCoord[1]);
        dot.setAttribute('r', 3.5);
        svg.appendChild(dot);

        card.appendChild(svg);
        return card;
      }

      function buildMasteryList() {
        const wrap = document.createElement('div');
        wrap.className = 'mastery-list';

        for (const lvl of LEVELS) {
          const xp = state.levelXp[lvl] || 0;
          const max = LEVEL_XP_MAX[lvl];
          const prestige = state.levelPrestige[lvl] || 0;
          const sub = getCurrentSublevel(lvl);
          const isMaxed = xp >= max;
          const pct = Math.min(100, (xp / max) * 100);

          const card = document.createElement('div');
          card.className = 'mastery';

          const starsHtml = prestige > 0
            ? `<span class="mastery__stars">${'★'.repeat(Math.min(prestige, 3))}${prestige > 3 ? `+${prestige - 3}` : ''}</span>`
            : '';

          card.innerHTML = `
            <span class="mastery__level ${isMaxed ? 'mastery__level--maxed' : ''}">${lvl}${starsHtml}</span>
            <div class="mastery__progress">
              <div class="mastery__row">
                <span class="mastery__sub ${sub.key === 'max' ? 'mastery__sub--max' : ''}">${escapeHtml(sub.name)}${sub.timed ? ' · timed' : ''}</span>
                <span class="mastery__xp">${xp} / ${max} XP</span>
              </div>
              <div class="mastery__bar">
                <div class="mastery__fill" style="width: ${pct}%"></div>
                <div class="mastery__ticks" aria-hidden="true">
                  <span class="mastery__tick"></span><span class="mastery__tick"></span><span class="mastery__tick"></span><span class="mastery__tick"></span>
                </div>
              </div>
            </div>
            <div class="mastery__action">
              <button type="button" class="mastery__prestige-btn" data-prestige="${lvl}" ${isMaxed ? '' : 'hidden'}>Prestige</button>
            </div>
          `;
          wrap.appendChild(card);
        }
        return wrap;
      }

      function buildSavedWordsCard() {
        const card = document.createElement('div');
        card.className = 'saved-card';

        const entries = Object.entries(state.savedWords)
          .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));

        if (entries.length === 0) {
          card.innerHTML = `
            <div class="saved-card__head">
              <p class="saved-card__title">Saved words</p>
            </div>
            <p class="saved-card__empty">Click the ★ inside any word's tooltip to save it here.</p>
          `;
          return card;
        }

        const items = entries.map(([key, data]) => {
          const original = data.original || key;
          const trans = data.trans || '—';
          return (
            `<li class="saved-card__item">` +
              `<span class="saved-card__word">${escapeHtml(original)}</span>` +
              `<span class="saved-card__trans">${escapeHtml(trans)}</span>` +
              `<button type="button" class="saved-card__remove" data-remove-saved="${escapeAttr(key)}" aria-label="Remove ${escapeAttr(original)}">×</button>` +
            `</li>`
          );
        }).join('');

        card.innerHTML = `
          <div class="saved-card__head">
            <p class="saved-card__title">Saved words</p>
            <span class="saved-card__count">${entries.length}</span>
          </div>
          <ul class="saved-card__list">${items}</ul>
        `;
        return card;
      }

      function buildFeedbackCard() {
        const card = document.createElement('div');
        card.className = 'feedback-card';
        const sentence = state.feedback?.sentence || '';
        card.innerHTML = `
          <p class="feedback-card__label">Focus</p>
          <p class="feedback-card__sentence ${sentence ? '' : 'feedback-card__sentence--loading'}" id="feedback-sentence">${sentence ? escapeHtml(sentence) : 'Analyzing your reading'}</p>
          <button type="button" class="feedback-card__refresh" id="feedback-refresh">Refresh suggestion</button>
        `;
        return card;
      }

      function attachProgressEvents() {
        $$('.mastery__prestige-btn').forEach((btn) => {
          btn.addEventListener('click', () => doPrestige(btn.dataset.prestige));
        });
        const refresh = $('#feedback-refresh');
        if (refresh) refresh.addEventListener('click', () => refreshFeedback(true));

        // Remove a saved word
        $$('[data-remove-saved]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const key = btn.dataset.removeSaved;
            if (!key) return;
            delete state.savedWords[key];
            saveStats();
            renderProgressView(); // re-render to update list + count
            // also un-star any matching tooltip in the (currently hidden) reader
            $$(`[data-save-word="${CSS.escape(key)}"]`).forEach((s) => {
              s.classList.remove('is-saved');
              s.setAttribute('aria-label', 'Save word');
              s.setAttribute('title', 'Save word');
            });
          });
        });
      }

      function doPrestige(level) {
        const xp = state.levelXp[level] || 0;
        const max = LEVEL_XP_MAX[level];
        if (xp < max) return;
        state.levelXp[level] = 0;
        state.levelPrestige[level] = (state.levelPrestige[level] || 0) + 1;
        saveStats();
        renderProgressView();
        renderStats();
        updateSublevelPillIfIdle();
      }

      async function refreshFeedback(userTriggered) {
        const sentenceEl = $('#feedback-sentence');
        const btn = $('#feedback-refresh');
        if (sentenceEl) {
          sentenceEl.classList.add('feedback-card__sentence--loading');
          sentenceEl.textContent = 'Analyzing your reading';
        }
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Generating…';
        }
        try {
          const sentence = await fetchFeedback();
          state.feedback = { sentence, generatedAt: Date.now() };
          saveStats();
          if (sentenceEl) {
            sentenceEl.classList.remove('feedback-card__sentence--loading');
            sentenceEl.textContent = sentence;
          }
        } catch (e) {
          if (sentenceEl) {
            sentenceEl.classList.remove('feedback-card__sentence--loading');
            sentenceEl.textContent = userTriggered
              ? 'Could not generate a suggestion right now — try again in a moment.'
              : 'Read a few texts, then refresh for a tailored suggestion.';
          }
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Refresh suggestion';
          }
        }
      }

      async function fetchFeedback() {
        const topWords = Object.entries(state.hoverWords)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([w, c]) => `${w} (${c}×)`)
          .join(', ');

        const levelStatus = LEVELS.map((lvl) => {
          const xp = state.levelXp[lvl] || 0;
          const max = LEVEL_XP_MAX[lvl];
          const p = state.levelPrestige[lvl] || 0;
          return `${lvl}: ${xp}/${max}${p ? ` p${p}` : ''}`;
        }).join(' · ');

        const userPrompt = topWords
          ? `Words this German learner has hovered for translation (frequency in parentheses): ${topWords}\n\nCurrent level: ${state.level}. Per-level mastery: ${levelStatus}.\n\nGive ONE concise sentence (max 24 words) advising what to focus on next. Be specific — name a grammatical category or theme suggested by the hovered words. No preamble, no quotes.`
          : `New German learner at level ${state.level}. Per-level mastery: ${levelStatus}.\n\nGive ONE concise sentence (max 24 words) advising what to focus on first. No preamble, no quotes.`;

        const body = {
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a calm, focused German tutor. Reply with ONLY the requested single sentence — no preamble, no quotes, no markdown.' },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.6,
        };

        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Feedback API ${res.status}`);
        const json = await res.json();
        const sentence = (json.choices?.[0]?.message?.content || '').trim();
        return sentence.replace(/^["']+|["']+$/g, '');
      }

      // credit the in-progress text when leaving the tab
      window.addEventListener('beforeunload', () => {
        try { finalizeSession(); } catch (_) {}
      });

      // boot --------------------------------------------------------------
      try {
        renderEmpty();
      } catch (e) {
        console.error('Deutschify boot failed:', e);
        cardBody.textContent = 'Initialization failed. Open the console for details.';
      }

      // ─────────────── Splash screen ───────────────
      // First-visit-per-session intro. After the user clicks Begin (or hits
      // Enter), it animates out and never returns this session. To re-show it,
      // clear sessionStorage.
      (() => {
        const splash = document.getElementById('splash');
        const cta    = document.getElementById('splash-cta');
        if (!splash || !cta) return;

        const SEEN_KEY = 'klar:splash-seen';
        let seen = false;
        try { seen = !!sessionStorage.getItem(SEEN_KEY); } catch (_) {}

        if (seen) {
          splash.hidden = true;
          return;
        }

        splash.hidden = false;

        function dismiss() {
          try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (_) {}
          splash.classList.add('is-leaving');
          // Remove from DOM after the exit transition so it can't trap focus
          setTimeout(() => { splash.hidden = true; splash.classList.remove('is-leaving'); }, 520);
        }

        cta.addEventListener('click', dismiss);
        document.addEventListener('keydown', function onKey(e) {
          if (splash.hidden) { document.removeEventListener('keydown', onKey); return; }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dismiss();
            document.removeEventListener('keydown', onKey);
          }
        });
      })();

      // ===================================================================
      // PREMIUM POLISH — scroll progress, topbar fade, loading rotation,
      // stat counter, mastery reveal, star pop
      // ===================================================================
      (() => {
        // Reading progress bar ------------------------------------------
        const progressBar = document.createElement('div');
        progressBar.className = 'read-progress';
        progressBar.setAttribute('aria-hidden', 'true');
        document.body.appendChild(progressBar);

        const topbar = document.querySelector('.topbar');

        function onScroll() {
          const scrollTop = window.scrollY || document.documentElement.scrollTop;
          const docH = document.documentElement.scrollHeight - window.innerHeight;
          const pct = docH > 0 ? Math.max(0, Math.min(100, (scrollTop / docH) * 100)) : 0;

          if (scrollTop > 8 && docH > 80) {
            progressBar.classList.add('is-visible');
            progressBar.style.width = pct + '%';
          } else {
            progressBar.classList.remove('is-visible');
          }

          if (topbar) {
            topbar.classList.toggle('is-scrolled', scrollTop > 24);
          }
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
      })();

      // Loading message rotation -----------------------------------------
      (() => {
        const MSGS = [
          'Wird geschrieben…',
          'Einen Moment, bitte…',
          'Bin gleich da…',
          'Texte werden vorbereitet…',
          'Fast fertig…',
        ];
        let timer = null;
        function start() {
          stop();
          let i = 0;
          timer = setInterval(() => {
            const el = document.getElementById('loading-msg');
            if (!el) return;
            i = (i + 1) % MSGS.length;
            el.classList.add('is-swapping');
            setTimeout(() => {
              el.textContent = MSGS[i];
              el.classList.remove('is-swapping');
            }, 280);
          }, 1800);
        }
        function stop() { if (timer) { clearInterval(timer); timer = null; } }

        // Hook into renderLoading by observing card-foot for the loading button
        const observer = new MutationObserver(() => {
          if (document.getElementById('loading-msg')) start();
          else stop();
        });
        const fc = document.getElementById('card-foot');
        if (fc) observer.observe(fc, { childList: true, subtree: true });
      })();

      // Stat card count-up + mastery bar reveal --------------------------
      window.__animateProgressView = function () {
        // Mastery bars — set --bar-target then add is-revealing for staggered fill
        const fills = document.querySelectorAll('.mastery__fill');
        fills.forEach((fill, i) => {
          const target = fill.style.width || '0%';
          fill.style.setProperty('--bar-target', target);
          fill.style.width = '0%';
          fill.classList.remove('is-revealing');
          // force reflow
          // eslint-disable-next-line no-unused-expressions
          fill.offsetHeight;
          fill.style.setProperty('--bar-delay', (i * 70) + 'ms');
          fill.classList.add('is-revealing');
        });

        // Stat values — count-up from 0
        const stats = document.querySelectorAll('.stat-card__value');
        stats.forEach((el) => {
          const text = el.textContent;
          const num = parseInt(text.replace(/[^\d-]/g, ''), 10);
          if (!Number.isFinite(num) || isNaN(num) || num <= 0) return;
          const dur = 700;
          const start = performance.now();
          const card = el.closest('.stat-card');
          if (card) card.classList.add('is-revealing');
          function tick(now) {
            const t = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = String(Math.round(num * eased));
            if (t < 1) requestAnimationFrame(tick);
            else {
              el.textContent = text;
              if (card) card.classList.remove('is-revealing');
            }
          }
          requestAnimationFrame(tick);
        });
      };

      // Star pop on save -------------------------------------------------
      document.addEventListener('click', (e) => {
        const star = e.target.closest('.word__tip-star');
        if (!star) return;
        star.classList.remove('is-popping');
        // force reflow so animation re-triggers
        // eslint-disable-next-line no-unused-expressions
        star.offsetHeight;
        star.classList.add('is-popping');
        setTimeout(() => star.classList.remove('is-popping'), 500);

        // Toast feedback after the click toggles savedWords
        setTimeout(() => {
          const isSaved = star.classList.contains('is-saved');
          const wordEl = star.closest('.word');
          const wordText = wordEl ? (wordEl.dataset.word || wordEl.textContent.trim()) : '';
          if (isSaved) {
            window.__toast && window.__toast({
              text: 'Saved <strong>' + (wordText.slice(0, 24)) + '</strong>',
              icon: 'star',
            });
          } else if (wordText) {
            window.__toast && window.__toast({
              text: 'Removed <strong>' + (wordText.slice(0, 24)) + '</strong>',
              icon: 'minus',
            });
          }
        }, 30);
      }, true);

      // ===================================================================
      // TOAST helper — call window.__toast({ text, icon })
      // ===================================================================
      (() => {
        const host = document.getElementById('toast-host');
        if (!host) return;

        const ICONS = {
          star:  '<svg class="toast__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.95 4.05 4.45.55-3.25 3.1.85 4.4L8 11.55l-4 2.05.85-4.4L1.6 6.1l4.45-.55z"/></svg>',
          minus: '<svg class="toast__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.5 8h9"/></svg>',
          check: '<svg class="toast__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3 7-7"/></svg>',
          xp:    '<svg class="toast__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 13l3-6.5 2.5 4.5 2.5-7 3 9"/></svg>',
        };

        window.__toast = function ({ text, icon = 'check', duration = 2400 }) {
          const t = document.createElement('div');
          t.className = 'toast';
          t.innerHTML = (ICONS[icon] || ICONS.check) + '<div class="toast__text">' + text + '</div>';
          host.appendChild(t);
          requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-visible')));
          setTimeout(() => {
            t.classList.remove('is-visible');
            setTimeout(() => t.remove(), 400);
          }, duration);
        };
      })();

      // ===================================================================
      // KEYBOARD SHORTCUTS OVERLAY — toggle with ?
      // ===================================================================
      (() => {
        const overlay = document.createElement('div');
        overlay.className = 'kbd-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
          <div class="kbd-overlay__backdrop"></div>
          <div class="kbd-overlay__panel" role="dialog" aria-modal="true" aria-labelledby="kbd-title">
            <div class="kbd-overlay__head">
              <h2 class="kbd-overlay__title" id="kbd-title">Keyboard shortcuts</h2>
              <button type="button" class="kbd-overlay__x" aria-label="Close">×</button>
            </div>
            <ul class="kbd-list">
              <li><span>Generate / next text</span><kbd>Enter</kbd></li>
              <li><span>New text</span><kbd>R</kbd></li>
              <li><span>Previous text</span><kbd>←</kbd></li>
              <li><span>Toggle DE / EN</span><kbd>L</kbd></li>
              <li><span>Read aloud</span><kbd>Space</kbd></li>
              <li><span>Fullscreen</span><kbd>F</kbd></li>
              <li><span>Progress view</span><kbd>P</kbd></li>
              <li><span>Settings</span><kbd>,</kbd></li>
              <li><span>Show this list</span><kbd>?</kbd></li>
              <li><span>Close any overlay</span><kbd>Esc</kbd></li>
            </ul>
          </div>
        `;
        document.body.appendChild(overlay);

        const close = overlay.querySelector('.kbd-overlay__x');
        const backdrop = overlay.querySelector('.kbd-overlay__backdrop');
        function show() { overlay.hidden = false; }
        function hide() { overlay.hidden = true; }
        close.addEventListener('click', hide);
        backdrop.addEventListener('click', hide);

        document.addEventListener('keydown', (e) => {
          // ? key — needs Shift+/ on most keyboards
          if (e.key === '?' && !e.target.closest('input,textarea,[contenteditable]')) {
            e.preventDefault();
            overlay.hidden ? show() : hide();
          } else if (e.key === 'Escape' && !overlay.hidden) {
            hide();
          }
        });
      })();

      // ===================================================================
      // EXTRA KEYBOARD SHORTCUTS — F, P, L, Space, Comma, Left arrow
      // ===================================================================
      (() => {
        function inField(t) {
          if (!t) return false;
          return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
        }

        document.addEventListener('keydown', (e) => {
          if (inField(e.target)) return;
          if (e.metaKey || e.ctrlKey || e.altKey) return;

          // F — toggle fullscreen
          if (e.key === 'f' || e.key === 'F') {
            const btn = document.getElementById('fullscreen-toggle');
            if (btn) { e.preventDefault(); btn.click(); }
          }
          // P — Progress view
          else if (e.key === 'p' || e.key === 'P') {
            const btn = document.querySelector('[data-view="progress"]');
            if (btn) { e.preventDefault(); btn.click(); }
          }
          // L — toggle DE/EN
          else if (e.key === 'l' || e.key === 'L') {
            const cur = document.querySelector('.lang-toggle__btn[aria-pressed="true"]');
            const next = cur && cur.nextElementSibling || document.querySelector('.lang-toggle__btn');
            const target = (cur && cur.nextElementSibling) ? cur.nextElementSibling : document.querySelector('.lang-toggle__btn[data-lang="de"]');
            if (target && !target.disabled) { e.preventDefault(); target.click(); }
          }
          // , — open Settings
          else if (e.key === ',') {
            const sb = document.getElementById('settings-btn');
            if (sb) { e.preventDefault(); sb.click(); }
          }
          // Space — read aloud (only when text is loaded, not in fields)
          else if (e.key === ' ' && state.lastData) {
            const speak = document.getElementById('speak-btn');
            if (speak && !speak.hidden) { e.preventDefault(); speak.click(); }
          }
          // Left arrow — previous text
          else if (e.key === 'ArrowLeft') {
            if (window.__navigatePrevious) { e.preventDefault(); window.__navigatePrevious(); }
          }
        });
      })();

      // ===================================================================
      // PREVIOUS TEXT history — keep last 8 texts, navigate with ←
      // ===================================================================
      (() => {
        if (!state.history) state.history = [];
        if (typeof state.historyIndex !== 'number') state.historyIndex = -1;

        // Wrap generate to push current text into history first
        const originalGenerate = generate;
        // (generate is in scope — we hook the renderArticle to track)

        // After every renderArticle, push to history (unless we're navigating back)
        const originalRenderArticle = renderArticle;
        window.__skipHistoryPush = false;
        Object.defineProperty(window, '_renderArticleWrapper', {
          value: function (data) {
            if (!window.__skipHistoryPush && data) {
              // Trim duplicates and limit length
              state.history.push(data);
              if (state.history.length > 8) state.history.shift();
              state.historyIndex = state.history.length - 1;
              renderHistoryControls();
            }
            window.__skipHistoryPush = false;
          },
        });

        // Inject a "Previous" button into the next-row footer when applicable
        function renderHistoryControls() {
          const foot = document.getElementById('card-foot');
          if (!foot) return;
          const nextBtn = foot.querySelector('#next');
          if (!nextBtn) return;
          // Already has back button?
          if (foot.querySelector('.btn-back')) return;
          // Need history items beyond current?
          if (state.historyIndex <= 0) return;

          const back = document.createElement('button');
          back.type = 'button';
          back.className = 'btn-secondary btn-back';
          back.setAttribute('aria-label', 'Previous text');
          back.title = 'Previous text (←)';
          back.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>';

          back.addEventListener('click', navigatePrevious);

          // Place to the LEFT of next-row
          const row = foot.querySelector('.next-row');
          if (row) {
            row.style.gridTemplateColumns = 'auto 1fr auto';
            row.insertBefore(back, row.firstChild);
          }
        }

        function navigatePrevious() {
          if (state.historyIndex <= 0) return;
          state.historyIndex -= 1;
          const data = state.history[state.historyIndex];
          if (!data) return;
          window.__skipHistoryPush = true;
          state.lastData = data;
          renderArticle(data);
          window.__toast && window.__toast({
            text: '<strong>Previous text</strong> ' + (state.historyIndex + 1) + ' / ' + state.history.length,
            icon: 'check',
            duration: 1500,
          });
        }
        window.__navigatePrevious = navigatePrevious;

        // Hook into renderArticle by wrapping it
        const _originalRA = renderArticle;
        // (reassignment not allowed for const declarations, so we patch via observer)
        // Use mutation observer on cardBody to detect new article rendering
        let lastDataRef = null;
        const obs = new MutationObserver(() => {
          if (state.lastData && state.lastData !== lastDataRef && !state.loading) {
            lastDataRef = state.lastData;
            window._renderArticleWrapper(state.lastData);
          }
        });
        const cb = document.getElementById('card-body');
        if (cb) obs.observe(cb, { childList: true });
      })();

      // ===================================================================
      // READING ROOMS — Default / Café / Library / Train
      // ===================================================================
      (() => {
        const ROOMS = ['default', 'cafe', 'library', 'train'];
        function applyRoom(room) {
          if (!ROOMS.includes(room)) room = 'default';
          ROOMS.forEach((r) => {
            if (r !== 'default') document.body.classList.remove('room-' + r);
          });
          if (room !== 'default') document.body.classList.add('room-' + room);
          state.room = room;
        }

        // Initial — load saved preference
        const saved = safeStore.get('deutschify:room');
        const initialRoom = ROOMS.includes(saved) ? saved : 'default';
        applyRoom(initialRoom);
        // Sync the toggle pressed state
        document.querySelectorAll('[data-room]').forEach((b) => {
          b.setAttribute('aria-pressed', b.dataset.room === initialRoom ? 'true' : 'false');
        });

        document.querySelectorAll('[data-room]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const room = btn.dataset.room;
            applyRoom(room);
            document.querySelectorAll('[data-room]').forEach((b) => {
              b.setAttribute('aria-pressed', b.dataset.room === room ? 'true' : 'false');
            });
            safeStore.set('deutschify:room', room);
          });
        });
      })();

      // ===================================================================
      // CHAT — AI tutor that teaches German conversationally
      // ===================================================================
      (() => {
        // ==========================================================================
        // CHAT BACKEND — multi-stage pipeline
        // --------------------------------------------------------------------------
        // 1. CLASSIFIER     — small fast call routes the user message to a scenario:
        //                     correct | word | quiz | fill | result | converse
        // 2. DRAFT          — focused per-scenario prompt produces a tight reply.
        //                     Each prompt = BASE_PERSONA + only the schema/rules it
        //                     needs, so the model isn't picking between 5 formats
        //                     while writing.
        // 3. HUMANIZE       — second pass strips AI cliché, tightens cadence, kills
        //                     em-dashes/sycophancy.
        // 4. REPAIR + STRIP — auto-fix common malformed-card output, em-dash safety
        //                     net, validation gates.
        //
        // Scenario routing means the prompt the model reads at each turn is
        // ~40-80 lines, focused on ONE job, instead of a 280-line tree it has to
        // navigate every time.
        // ==========================================================================

        const BASE_PERSONA = `You are a German tutor inside the Deutschify app. Persona: a knowledgeable, slightly dry, friendly German speaker who treats the learner as an intelligent adult. Not a cheerleader. Not a drill sergeant. Not a customer-service bot. A well-liked traveler who adjusts to the person they are talking to without pandering.

SENIOR-EMPLOYEE HEURISTIC. A thoughtful senior tutor reviewing your reply would flag any of these as failures: wishy-washy hedging, unprompted moralizing, condescension, unrequested cultural lectures, preachy or paternalistic wording, walls of bullets where prose belongs, restating the learner's question before answering, always ending with a "let me know", performative warmth. If a senior tutor would call your reply fake, rewrite it.

VOICE.
Open with the answer, never with acknowledgement. Never start with: "Great question", "Of course", "Absolutely", "Certainly", "Sure", "I'd be happy to", "Happy to help", "Let me help", "I'm glad you asked", "Sehr gut", "Wunderbar", "Toll", "Klasse". No flattery. Never call any input good, great, fascinating, profound, interesting, insightful, smart, or excellent.

Never end with: "I hope this helps", "Let me know if you have more questions", "Feel free to ask", "Hope that clarifies". When you're done, stop. Silence is fine.

BANNED VOCAB (these mark text as AI-generated): delve, dive into, unpack, shed light on, pave the way, underscore, bolster, harness, leverage, foster, navigate (figuratively), elevate, streamline, facilitate, illuminate, embark, the realm of, the world of, the landscape of, tapestry, journey (figuratively), framework, intricacies, testament, beacon, crucial, pivotal, vital, essential, comprehensive, robust, multifaceted, meticulous, holistic, seamless, intricate, exciting, incredible, powerful, transformative, game-changing, groundbreaking, revolutionary, fascinating, profound, remarkable.

BANNED OPENERS: "It's important to note that", "It's worth mentioning", "Generally speaking", "In today's...", "In an era where", "When it comes to", "At its core", "Let's dive in", "Let's explore", "In conclusion", "Ultimately".

BANNED PATTERNS: bold-term-then-explanation lists ("**Term**: definition..."), false-contrast frames ("It's not just X, it's Y"), restating the question before answering, summarizing what you just said.

ABSOLUTE: Never use em-dashes (—) or en-dashes (–). Use commas, periods, parentheses, or split into two sentences.

CADENCE. Short sentences mixed with one or two longer ones. Vary rhythm. A four-word sentence next to a fifteen-word one.

LENGTH. Match the question. One-word query → 1-2 sentences. Casual chat reply → a few sentences. "Explain X" → brief summary, expand only if asked. Never dump comprehensive answers by default.

PRAISE. No "you're so smart", "great job", "Sehr gut!" for trivial input. Default response to correct German is to engage with content, not grade form. Treating correct German as unremarkable IS the warmth. Praise only when warranted, at task/process level.

LANGUAGE. Default to German at the learner's level. Comprehensible input: aim slightly above current level, gloss only new words. Switch to English for genuine breakdowns or when the learner writes English. Use authentic discourse particles in informal register: ja, doch, halt, eben, mal, wohl, schon, bloß, eh, ne.

HONESTY. Diplomatically honest, not dishonestly diplomatic. If the learner asserts something incorrect, correct them. Don't capitulate to push-back without a real reason. If you don't know, say "Da bin ich nicht ganz sicher" plainly. No "As an AI" disclaimers.

CONVERSATIONAL. Don't always end with a question. When you do ask, ask ONE. Don't restate. Don't summarize. No emojis unless the learner uses one first.

WRAP every German word/phrase in your prose in <em></em>. The reader scans for highlights.`;

        // ===================== STAGE 1 — CLASSIFIER =====================
        // Tiny fast call. Routes the user message to a scenario.

        const CLASSIFIER_SYSTEM = `Classify the user's most recent message in a German tutoring chat.

Output exactly one word: correct, word, quiz, fill, or converse. No punctuation, no explanation.

correct → The user wrote German that needs fixing. ANY of these qualify:
  • German appears in their message (whole message, in quotes, after a bullet, after "I'd say...", "is this right?", "ist das richtig?", "would I say...", "I'll go like...", "check this", "fix this", "correct me", "the right way to say it") AND has 2+ substantive errors.
  • They explicitly ask for correction even with 1 error.
  • Heuristic: if a fluent German speaker would naturally say "let me clean that up" — it's correct.

word → User asks what a single German word means OR how to say a single English word in German. Triggers: a single German word alone, "what does X mean?", "how do you say tired?", "translate X", "what's the German for Y?".

quiz → User explicitly asks to be tested with multiple choice. "test me", "quiz me", "give me a question".

fill → User explicitly asks for fill-in-the-blank drills. "drill me on cases", "practice der/die/das", "fill in the blanks", "give me blanks".

converse → Everything else: grammar explanations, conversation practice, multi-word questions, register/usage questions, definitional questions about phrases, casual chat, follow-ups.

Output exactly one of: correct word quiz fill converse`;

        // ===================== STAGE 2 — SCENARIO PROMPTS =====================
        // Each draft prompt = BASE_PERSONA + only the format/schema for ONE scenario.

        const SCENARIO_CORRECT = `${BASE_PERSONA}

==========================
TASK: CORRECTION CARD
==========================
The learner showed you German they wrote. It has 2+ errors. Produce a structured CORRECTION CARD as your reply.

OUTPUT (in order, nothing else):
1. ONE short intro line, 6 to 18 words. Acknowledge briefly without listing the fixes. Examples: "Not how German lines up. Here:" / "Three things to clean up:" / "Close, but a couple snags:". Never list errors in this intro.
2. A single <correct> tag with <fix> children + <rewrite>. Nothing after </correct>.

Schema:
<correct original="THE LEARNER'S ORIGINAL GERMAN, EXACTLY AS THEY WROTE IT">
  <fix wrong="EXACT_SUBSTRING_FROM_ORIGINAL" right="CORRECT_FORM" why="UNDER 12 WORDS, plain English"/>
  <fix wrong="..." right="..." why="..."/>
  <rewrite>The full clean version of the sentence.</rewrite>
</correct>

RULES.
- 1 to 4 <fix> tags. Most-impactful errors first.
- "wrong" MUST be a literal substring of "original". The renderer searches for it. Do not paraphrase.
- "original" contains ONLY the German part. Strip English framing ("so if I say...", "is this right?", any leading bullet "  • ").
- "why" is one short reason in plain English. No grammar jargon dump. Under 12 words.
- "rewrite" is the corrected sentence in clean German, no markup.
- Do NOT wrap anything inside <correct> in <em>.
- The card IS the answer. Never write a prose paragraph after the intro that re-explains the fixes — every explanation lives in a "why" attribute.

EXAMPLE.
Learner: hey is this the right way to say it? "Du bis seer Geil"
Reply:
Three things to clean up:
<correct original="Du bis seer Geil">
  <fix wrong="bis" right="bist" why="2nd person of sein is bist, not bis"/>
  <fix wrong="seer" right="sehr" why="very is spelled sehr, with h not double e"/>
  <fix wrong="Geil" right="geil" why="adjective mid-sentence is lowercase"/>
  <rewrite>Du bist sehr geil.</rewrite>
</correct>`;

        const SCENARIO_WORD = `${BASE_PERSONA}

==========================
TASK: WORD BREAKDOWN
==========================
The user is asking about a single German word or how to say a single English word in German.

OUTPUT.
1. ONE short conversational lead-in that gives the meaning plainly, 10 to 25 words. Wrap the German word in <em></em>. No flattery, no "let me show you", just the answer with a natural lead-in. Examples: "<em>Müde</em> means tired. Here's how it works." / "<em>Bürgeramt</em> is the citizen services office, the place you dread visiting."
2. The <word> tag. Nothing after </word>.

Schema:
<word de="GERMAN_WORD" en="english_meaning" type="noun|verb|adjective|adverb|phrase" article="der|die|das|" plural="" past="" perfect="" auxiliary="haben|sein" comparative="" superlative="">
  <note>One sentence in plain words: when this word actually shows up in real life. Register, situations. No restating the meaning. No textbook tone.</note>
  <ex de="Real example using <em>WORD</em>." en="English translation."/>
  <ex de="Second example with <em>WORD</em> in a different context." en="Second translation."/>
</word>

RULES.
- Required fields by type:
  • noun: de, en, article (der/die/das), plural
  • verb: de (infinitive), en, past (Präteritum 3.Sg), perfect (full Perfekt, e.g. "hat gemacht"), auxiliary
  • adjective: de, en, comparative, superlative ("am ___sten")
  • phrase / adverb: de, en
- Always exactly 2 examples. Wrap the target word inside each example's de attribute in <em></em>.`;

        const SCENARIO_QUIZ = `${BASE_PERSONA}

==========================
TASK: QUIZ
==========================
The user wants to be tested. Send a multiple-choice <quiz>.

OUTPUT.
1. ONE short intro line. Examples: "Try this one:" / "Quick check:" / "See if you spot it:".
2. The <quiz> tag. Nothing after </quiz>.

Schema:
<quiz q="QUESTION_TEXT" answer="N">
  <opt>First option</opt>
  <opt>Second option</opt>
  <opt>Third option</opt>
</quiz>

RULES.
- q MUST be a real, non-empty question.
- 3 or 4 <opt> tags, all distinct.
- answer is the 1-indexed number of the correct <opt>.
- Wrap German words in option text in <em></em>.
- Never include an "explanation" attribute. Teaching happens in the follow-up after the user answers.
- The card is self-contained. Don't put a closing question after </quiz>.`;

        const SCENARIO_FILL = `${BASE_PERSONA}

==========================
TASK: FILL IN THE BLANK
==========================
The user wants drill practice. Send a <fill> card.

OUTPUT.
1. ONE short intro line. Examples: "Try these:" / "Drill on Akkusativ:".
2. The <fill> tag. Nothing after </fill>.

Schema:
<fill q="QUESTION_OR_INSTRUCTION">
  <blank prefix="Ich sehe " answer="den" suffix=" Hund." options="der,den,dem,des"/>
  <blank prefix="Sie hilft " answer="dem" suffix=" Mann." options="der,den,dem,des"/>
</fill>

RULES.
- 2 to 4 <blank> tags.
- prefix/suffix: optional German text around the blank.
- answer: the correct answer. Lowercase exactly as a learner would type, unless the word is a noun (capitalized).
- options: optional comma-separated dropdown choices. If provided, the answer MUST appear inside that list (case-insensitive). Omit options for free typing.
- All blanks in one card test the SAME pattern.`;

        const SCENARIO_RESULT = `${BASE_PERSONA}

==========================
TASK: RESPOND TO QUIZ / FILL ANSWER
==========================
The user just answered a card. The system message starts with [Quiz result] or [Fill result]. Always respond. Don't restate the question. Don't be a scoreboard.

WRONG ANSWERS.
- Lead with a brief specific acknowledgement, not a formula. "Hmm, close." / "Tricky." / "Nope, the trap is here."
- Explain the actual mistake in plain words and a concrete image. No grammar terms first.
- Give a memory hook: a phrase, a tiny pattern, something they can hold onto.
- ONE clear next step. Vary it. "Want another?" / "Want me to drill it?" / "Move on?"
- If you send a follow-up <fill>, target the exact pattern they missed.

RIGHT ANSWERS.
- One short acknowledgement. "Got it." / "That's the one." / "Yep."
- ONE useful next-level thing: an exception, a register tip, a related word, a native quirk.
- ONE clear next step.

2 to 4 sentences. Adult to adult.`;

        const SCENARIO_CONVERSE = `${BASE_PERSONA}

==========================
TASK: CONVERSATION
==========================
The user is asking a grammar question, having a chat, requesting an explanation, or asking about usage. NO card. Plain prose.

OUTPUT.
- 2 to 4 short sentences. Wrap German in <em></em>.
- Use <code></code> only for the corrected form of a single inline mistake (the kind too small for a correction card).
- No markdown. No headers. No bullet lists. Lists allowed only for genuinely discrete items (verb conjugation, three case endings) when explicitly relevant.

INLINE-CORRECTION FORMAT (when there's exactly 1 minor slip).
Corrected form, brief reason, continuation. Example.
Learner: "Ich habe gestern in das Kino gegangen."
Reply: <code>bin gegangen</code> (Bewegungsverb, sein), und <em>ins Kino</em>. Was hast du gesehen?

For typos and meaning-clear minor slips that don't reflect a rule gap: continue the conversation without correcting. Uptake suffers when every error is flagged.`;

        const SCENARIO_PROMPTS = {
          correct:  SCENARIO_CORRECT,
          word:     SCENARIO_WORD,
          quiz:     SCENARIO_QUIZ,
          fill:     SCENARIO_FILL,
          result:   SCENARIO_RESULT,
          converse: SCENARIO_CONVERSE,
        };

        const messagesEl = document.getElementById('chat-messages');
        const introEl    = document.getElementById('chat-intro');
        const form       = document.getElementById('chat-form');
        const field      = document.getElementById('chat-field');
        const sendBtn    = document.getElementById('chat-send');
        const chatRoot   = document.getElementById('chat');
        if (!messagesEl || !form || !field || !sendBtn) return;

        // Start in empty state — input + intro centered together
        if (chatRoot) chatRoot.classList.add('chat--empty');

        // Scroll-edge vignette — iOS scrollEdgeAppearance pattern.
        // The whole chat is taller than the viewport, so the WINDOW is what
        // scrolls (not chat__messages internally). Opacity of each
        // progressive-blur tracks how far the window has scrolled from each
        // edge: at very top, top opacity = 0; scrolling down ~80px fades it
        // in. Same on the bottom edge. Updates are rAF-coalesced and the
        // scroll listener is passive so scrolling stays smooth regardless of
        // how often events fire.
        const viewChatEl = document.getElementById('view-chat');
        const SCROLL_FADE_DIST = 80;
        let _vignetteFrame = null;
        function updateScrollVignette() {
          _vignetteFrame = null;
          if (!viewChatEl) return;
          const docEl = document.documentElement;
          const st = window.scrollY || docEl.scrollTop || 0;
          const sh = docEl.scrollHeight;
          const ch = docEl.clientHeight;
          const fromBottom = Math.max(sh - ch - st, 0);
          const topOp = Math.min(Math.max(st / SCROLL_FADE_DIST, 0), 1);
          const botOp = Math.min(Math.max(fromBottom / SCROLL_FADE_DIST, 0), 1);
          viewChatEl.style.setProperty('--pb-top-opacity',    topOp.toFixed(3));
          viewChatEl.style.setProperty('--pb-bottom-opacity', botOp.toFixed(3));
        }
        function scheduleScrollVignette() {
          if (_vignetteFrame === null) {
            _vignetteFrame = requestAnimationFrame(updateScrollVignette);
          }
        }
        window.addEventListener('scroll', scheduleScrollVignette, { passive: true });
        // Re-evaluate when document height changes (new message appended,
        // textarea grows). Without this, the bottom vignette wouldn't update
        // when content is added below without a user scroll.
        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(scheduleScrollVignette).observe(document.body);
        }

        const history = [];

        // Render the structured <word> card with clear labeled sections
        function buildWordCardHTML(attrs, note, examples) {
          const esc = (s) => String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

          const article = attrs.article || '';
          const de      = attrs.de || '';
          const en      = attrs.en || '';
          const type    = (attrs.type || '').toLowerCase();

          let typeLabel = '';
          if (type === 'noun') {
            typeLabel = article === 'die' ? 'feminine noun'
                      : article === 'der' ? 'masculine noun'
                      : article === 'das' ? 'neuter noun'
                      : 'noun';
          } else if (type) {
            typeLabel = type;
          }

          // Forms section — key-value pairs
          const forms = [];
          if (attrs.plural)      forms.push({ k: 'Plural',      v: (article ? 'die ' : '') + attrs.plural });
          if (attrs.past)        forms.push({ k: 'Präteritum',  v: attrs.past });
          if (attrs.perfect)     forms.push({ k: 'Perfekt',     v: attrs.perfect });
          if (attrs.auxiliary)   forms.push({ k: 'Auxiliary',   v: attrs.auxiliary });
          if (attrs.comparative) forms.push({ k: 'Comparative', v: attrs.comparative });
          if (attrs.superlative) forms.push({ k: 'Superlative', v: attrs.superlative });

          let html = '<div class="word-card">';

          // HEAD — article muted + bold white word, NO highlight on headword
          html += '<div class="word-card__head-wrap">';
          html += '<div class="word-card__head">';
          if (article) html += `<span class="word-card__article">${esc(article)}</span>`;
          html += `<span class="word-card__de">${esc(de)}</span>`;
          html += '</div>';
          if (typeLabel) html += `<p class="word-card__type">${esc(typeLabel)}</p>`;
          html += '</div>';

          // MEANING — special amber-tinted section
          if (en) {
            html += '<section class="word-card__section word-card__section--meaning">';
            html += '<span class="word-card__label">Meaning</span>';
            html += `<p class="word-card__en">${esc(en)}</p>`;
            html += '</section>';
          }

          // FORMS — each form is its own labeled section with a divider above
          forms.forEach((f) => {
            html += '<section class="word-card__section">';
            html += `<span class="word-card__label">${esc(f.k)}</span>`;
            html += `<p class="word-card__form-value">${esc(f.v)}</p>`;
            html += '</section>';
          });

          // USAGE
          if (note) {
            html += '<section class="word-card__section">';
            html += '<span class="word-card__label">Usage</span>';
            html += `<p class="word-card__note">${esc(note)}</p>`;
            html += '</section>';
          }

          // EXAMPLES — each example divided by hairline
          if (examples.length > 0) {
            html += '<section class="word-card__section">';
            html += '<span class="word-card__label">Examples</span>';
            html += '<div class="word-card__examples">';
            examples.forEach((ex) => {
              const deProcessed = esc(ex.de)
                .replace(/&lt;em&gt;([\s\S]*?)&lt;\/em&gt;/g, '<mark>$1</mark>');
              html += `<div class="word-card__ex"><span class="word-card__ex-de">${deProcessed}</span><span class="word-card__ex-en">${esc(ex.en)}</span></div>`;
            });
            html += '</div>';
            html += '</section>';
          }

          html += '</div>';
          return html;
        }

        function parseAttrs(str) {
          const attrs = {};
          const re = /(\w+)="([^"]*)"/g;
          let m;
          while ((m = re.exec(str)) !== null) attrs[m[1]] = m[2];
          return attrs;
        }

        // Helpers — inline formatting allows <em>, <strong>, <code>
        const esc = (s) => String(s || '')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const formatInline = (s) => esc(s)
          .replace(/&lt;(\/?(?:em|strong|code))&gt;/g, '<$1>');

        // Build interactive QUIZ card
        // RULE: every quiz MUST have a question. Falls back if AI omits it.
        function buildQuizHTML(attrs, opts) {
          const q = (attrs.q || '').trim() || 'Pick the right answer:';
          const correct = parseInt(attrs.answer, 10) || 1;
          const explanation = attrs.explanation || '';

          // Drop duplicate options
          const seen = new Set();
          const uniqueOpts = opts.filter((o) => {
            const k = (o || '').trim().toLowerCase();
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          });

          let html = `<div class="quiz" data-answer="${correct}" data-q="${esc(q)}">`;
          html += `<p class="quiz__q">${formatInline(q)}</p>`;
          html += '<div class="quiz__opts">';
          uniqueOpts.forEach((opt, i) => {
            const idx = i + 1;
            const letter = String.fromCharCode(64 + idx);
            html += `<button type="button" class="quiz__opt" data-idx="${idx}">`;
            html += `<span class="quiz__opt-marker">${letter}</span>`;
            html += `<span class="quiz__opt-text">${formatInline(opt)}</span>`;
            html += '<svg class="quiz__opt-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>';
            html += '</button>';
          });
          html += '</div>';
          if (explanation) html += `<div class="quiz__explanation">${formatInline(explanation)}</div>`;
          html += '</div>';
          return html;
        }

        // Build CORRECTION card — teacher-style markup for German submitted by the user.
        // Renders three zones: original with inline strikes/inserts, numbered fix list, clean rewrite.
        function buildCorrectHTML(attrs, fixes, rewrite) {
          const original = attrs.original || '';

          // Mark up the original: struck-through wrong substrings with a small numbered superscript.
          // No inline replacements — the fix list and rewrite below carry the corrections, so the
          // top zone's only job is "what you wrote, with mistakes flagged".
          let marked = esc(original);
          fixes.forEach((fx, i) => {
            const wrongRaw = fx.wrong || '';
            if (!wrongRaw) return;
            const wrongEsc = esc(wrongRaw);
            const idx = marked.indexOf(wrongEsc);
            if (idx === -1) return;
            const num = i + 1;
            const replacement = `<span class="correct-card__strike">${wrongEsc}<sup class="correct-card__strike-num">${num}</sup></span>`;
            marked = marked.slice(0, idx) + replacement + marked.slice(idx + wrongEsc.length);
          });

          let html = '<div class="correct-card">';

          html += '<div class="correct-card__head">';
          html += '<span class="correct-card__label">Your sentence</span>';
          html += `<p class="correct-card__original">${marked}</p>`;
          html += '</div>';

          if (fixes.length > 0) {
            html += '<div class="correct-card__fixes">';
            fixes.forEach((fx, i) => {
              html += '<div class="correct-card__fix">';
              html += `<span class="correct-card__fix-num">${i + 1}</span>`;
              html += '<div class="correct-card__fix-body">';
              html += '<p class="correct-card__fix-line">';
              html += `<span class="correct-card__fix-wrong">${esc(fx.wrong || '')}</span>`;
              html += '<svg class="correct-card__fix-arrow" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10"/><path d="M9 4l4 4-4 4"/></svg>';
              html += `<span class="correct-card__fix-right">${esc(fx.right || '')}</span>`;
              html += '</p>';
              if (fx.why) html += `<p class="correct-card__fix-why">${formatInline(fx.why)}</p>`;
              html += '</div>';
              html += '</div>';
            });
            html += '</div>';
          }

          if (rewrite) {
            html += '<div class="correct-card__rewrite">';
            html += '<span class="correct-card__label correct-card__label--ok">Clean</span>';
            html += `<p class="correct-card__rewrite-text">${formatInline(rewrite)}</p>`;
            html += '</div>';
          }

          html += '</div>';
          return html;
        }

        // Build interactive FILL card
        function buildFillHTML(attrs, blanks) {
          const q = attrs.q || '';

          let html = '<div class="fill">';
          if (q) html += `<p class="fill__q">${formatInline(q)}</p>`;
          html += '<div class="fill__rows">';
          blanks.forEach((blank) => {
            const opts = (blank.options || '').split(',').map((s) => s.trim()).filter(Boolean);
            html += `<div class="fill__row" data-answer="${esc(blank.answer || '')}">`;
            if (blank.prefix) html += `<span>${formatInline(blank.prefix)}</span>`;
            if (opts.length > 0) {
              html += '<div class="fill__dd" data-value="">';
              html += '<button type="button" class="fill__dd-btn" aria-haspopup="listbox" aria-expanded="false">';
              html += '<span class="fill__dd-value is-empty">—</span>';
              html += '<svg class="fill__dd-chev" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
              html += '</button>';
              html += '<div class="fill__dd-menu" role="listbox" hidden>';
              opts.forEach((o) => {
                html += `<button type="button" class="fill__dd-opt" data-val="${esc(o)}" role="option">${esc(o)}</button>`;
              });
              html += '</div>';
              html += '</div>';
            } else {
              html += '<input type="text" class="fill__input" placeholder="…" autocomplete="off" />';
            }
            if (blank.suffix) html += `<span>${formatInline(blank.suffix)}</span>`;
            html += '</div>';
          });
          html += '</div>';
          html += '<button type="button" class="fill__check">Check</button>';
          html += '</div>';
          return html;
        }

        // Sanitize AI HTML — extract structural cards first, escape rest, restore
        function safeHtml(text) {
          const cards = [];

          // <word>
          let processed = text.replace(
            /<word\s+([^>]*?)>([\s\S]*?)<\/word>/g,
            (match, attrsStr, inner) => {
              const attrs = parseAttrs(attrsStr);
              const noteMatch = inner.match(/<note>([\s\S]*?)<\/note>/);
              const note = noteMatch ? noteMatch[1].trim() : '';
              const examples = [];
              const exRe = /<ex\s+de="([^"]*)"\s+en="([^"]*)"\s*\/?>(?:<\/ex>)?/g;
              let em;
              while ((em = exRe.exec(inner)) !== null) {
                examples.push({ de: em[1], en: em[2] });
              }
              cards.push(buildWordCardHTML(attrs, note, examples));
              return `__CARD_${cards.length - 1}__`;
            }
          );

          // <quiz>
          processed = processed.replace(
            /<quiz\s+([^>]*?)>([\s\S]*?)<\/quiz>/g,
            (match, attrsStr, inner) => {
              const attrs = parseAttrs(attrsStr);
              const opts = [];
              const optRe = /<opt[^>]*>([\s\S]*?)<\/opt>/g;
              let om;
              while ((om = optRe.exec(inner)) !== null) opts.push(om[1].trim());
              cards.push(buildQuizHTML(attrs, opts));
              return `__CARD_${cards.length - 1}__`;
            }
          );

          // <fill>
          processed = processed.replace(
            /<fill\s*([^>]*?)>([\s\S]*?)<\/fill>/g,
            (match, attrsStr, inner) => {
              const attrs = parseAttrs(attrsStr);
              const blanks = [];
              const blankRe = /<blank\s+([^>]*?)\/?\s*>(?:<\/blank>)?/g;
              let bm;
              while ((bm = blankRe.exec(inner)) !== null) {
                blanks.push(parseAttrs(bm[1]));
              }
              cards.push(buildFillHTML(attrs, blanks));
              return `__CARD_${cards.length - 1}__`;
            }
          );

          // <correct>
          processed = processed.replace(
            /<correct\s+([^>]*?)>([\s\S]*?)<\/correct>/g,
            (match, attrsStr, inner) => {
              const attrs = parseAttrs(attrsStr);
              const fixes = [];
              const fixRe = /<fix\s+([^>]*?)\/?\s*>(?:<\/fix>)?/g;
              let fm;
              while ((fm = fixRe.exec(inner)) !== null) {
                fixes.push(parseAttrs(fm[1]));
              }
              const rewriteM = inner.match(/<rewrite>([\s\S]*?)<\/rewrite>/);
              const rewrite = rewriteM ? rewriteM[1].trim() : '';
              cards.push(buildCorrectHTML(attrs, fixes, rewrite));
              return `__CARD_${cards.length - 1}__`;
            }
          );

          // Escape rest, allow safe inline tags
          let html = processed
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/&lt;(\/?(?:em|strong|code))&gt;/g, '<$1>')
            .replace(/&lt;br\s*\/?&gt;/g, '<br>')
            .replace(/\n/g, '<br>');

          // Convert any leftover markdown (AI sometimes slips into **bold** despite
          // being told not to). Operates on the already-escaped string.
          html = html
            // **bold** / __bold__ → <strong>
            .replace(/\*\*([^\*\n]+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
            // *italic* / _italic_ → <em>  (single delimiter, not adjacent to another)
            .replace(/(^|[\s\(\[])\*([^\*\n]+?)\*(?=$|[\s\.,;:!\?\)\]])/g, '$1<em>$2</em>')
            .replace(/(^|[\s\(\[])_([^_\n]+?)_(?=$|[\s\.,;:!\?\)\]])/g, '$1<em>$2</em>')
            // `code` → <code>
            .replace(/`([^`\n]+?)`/g, '<code>$1</code>')
            // Strip leading bullet markers ("- ", "* ", "1. ") at line starts
            .replace(/(^|<br>)\s*[\-\*]\s+/g, '$1')
            .replace(/(^|<br>)\s*\d+\.\s+/g, '$1')
            // Strip header markers (#, ##, ###) at line starts
            .replace(/(^|<br>)\s*#{1,6}\s+/g, '$1')
            // "quoted text" → <q>quoted text</q> — italic serif treatment.
            // Matches plain " ... " AND smart quotes “ ... ” / „ ... ".
            // Won't match across HTML tags or line breaks.
            .replace(/"([^"<>\n]{1,200})"/g, '<q>$1</q>')
            .replace(/[“„]([^”“"<>\n]{1,200})[”“]/g, '<q>$1</q>');

          cards.forEach((cardHtml, i) => {
            html = html.replace(`__CARD_${i}__`, cardHtml);
          });

          return html;
        }
        function escapeText(text) {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        const THINKING_SVG = `<span class="slime" role="status" aria-label="Thinking"><span class="slime__inner"></span></span>`;

        function appendMessage(role, html, opts = {}) {
          if (introEl && introEl.parentNode) introEl.remove();
          if (chatRoot) chatRoot.classList.remove('chat--empty');
          const msg = document.createElement('div');
          msg.className = 'chat__msg chat__msg--' + role;
          if (opts.loading) {
            // No bubble chrome during thinking — just the blob slime SVG
            msg.classList.add('chat__msg--thinking');
            msg.innerHTML = THINKING_SVG;
          } else {
            msg.innerHTML = html;
            // Freeze the bloom animation after it plays so re-show doesn't replay
            setTimeout(() => msg.classList.add('is-bloomed'), 1800);
          }
          messagesEl.appendChild(msg);
          requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          });
          return msg;
        }

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // ─────────── PIPELINE: draft → humanize → strip em-dashes ───────────

        const HUMANIZE_SYSTEM = `You rewrite a German tutor's reply so it sounds like a real human texting a friend, not a polished AI. You are a copy-editor with very strong opinions about AI cliché.

ABSOLUTE RULES:

1. ZERO em-dashes (—) or en-dashes (–) in the output. Replace with commas, periods, or parentheses. If a sentence relies on a dash, split it into two short sentences.

2. Plain everyday words. Replace any AI-tell vocabulary with simpler alternatives:
delve, dive into, unpack, shed light on, pave the way, underscore, bolster, harness, leverage, foster, navigate (figuratively), elevate, streamline, facilitate, illuminate, embark, the realm of, the world of, the landscape of (figuratively), tapestry, journey (figuratively), framework, intricacies, testament, beacon, crucial, pivotal, vital, essential, comprehensive, robust, multifaceted, meticulous, holistic, seamless, intricate, exciting, incredible, powerful, transformative, game-changing, groundbreaking, revolutionary, fascinating, profound, remarkable.

3. Strip ALL sycophantic openers. If the reply starts with "Great", "Of course", "Absolutely", "Certainly", "Sure", "I'd be happy", "Happy to help", "Let me", "I'm glad", "What a [adjective]", "Sehr gut", "Wunderbar", "Toll", "Klasse" — delete the whole opening phrase. Start with the actual content.

4. Strip ALL closing platitudes. If the reply ends with "Hope this helps", "Let me know", "Feel free to ask", "Hope that clarifies", "Reflecting a broader trend", "In conclusion", "Ultimately" — delete them. End on the actual content.

5. Strip throat-clearing preambles: "It's important to note that", "It's worth mentioning", "Generally speaking", "In today's [anything]", "In an era where", "When it comes to", "At its core", "Let's dive in", "Let's explore", "This is where X comes in".

6. Strip false-contrast frames: "It's not just X, it's Y", "Not only X, but Y", "This isn't about X. It's about Y". Rewrite as a direct statement.

7. Strip the bold-term-list pattern. If the reply has lines like "**Term**: definition...", flatten to prose.

8. Strip "As an AI" disclaimers. Strip performative humility ("I'm just an AI", "I might be wrong"). Strip restating the question before answering.

9. Keep all structured tags EXACTLY as they are: <word>, <quiz>, <fill>, <correct>, <em>, <code>, <strong>, <ex>, <opt>, <blank>, <note>, <fix>, <rewrite>. Same attributes. Same content. Only rewrite the prose around and inside <note> contents where it's natural language. Do NOT touch <ex de="..." en="..."/> or <fix wrong="..." right="..." why="..."/> attributes. Do NOT modify the <correct original="..."> attribute or <rewrite> contents.

10. Same meaning. Same length or shorter. Do not add new info. Do not add disclaimers like "however", "keep in mind", "that said". Do not add "let me know" follow-ups.

11. Vary sentence length. Mix one short sentence with one slightly longer one. Real human cadence, not the AI rhythm of uniform medium sentences.

12. Don't always end with a question. Sometimes a statement is the right ending. If the reply ends with a "Want another?" style offer, that's fine, but don't add one if it isn't there.

13. Output ONLY the rewritten reply. No "Here is the rewrite" preamble. No commentary.`;

        // Plain-text typewriter: each word stream-fades in with stagger.
        // Whitespace chunks pass through as-is, except \n which becomes <br> so
        // multi-line user messages preserve their line breaks in the bubble.
        function cascadeWords(text) {
          const parts = String(text || '').split(/(\s+)/);
          let html = '';
          let idx = 0;
          for (const p of parts) {
            if (/\S/.test(p)) {
              html += `<span class="stream-word" style="--w-delay:${idx * 32}ms">${escapeText(p)}</span>`;
              idx++;
            } else {
              html += p.replace(/\n/g, '<br>');
            }
          }
          return html;
        }

        // Rich-HTML typewriter: takes safeHtml output (with <em>/<strong>/<code>/<q>/<br>)
        // and wraps each word OR tagged inline unit in a stream-* span with stagger delay.
        // Result: bubble fades in word-by-word AND keeps highlights / quotes / corrections.
        function cascadeRichHtml(html) {
          const STAGGER = 36;
          const TAG_TO_CLASS = { em: 'stream-em', strong: 'stream-strong', code: 'stream-code', q: 'stream-q' };
          let out = '';
          let idx = 0;
          // Match: tagged inline unit | <br> | non-tag/non-space chunk | whitespace
          const re = /<(em|strong|code|q)>([\s\S]*?)<\/\1>|<br\s*\/?>|([^<\s]+)|(\s+)/g;
          let m;
          while ((m = re.exec(html)) !== null) {
            if (m[1]) {
              const tag = m[1];
              const inner = m[2];
              const cls = TAG_TO_CLASS[tag];
              out += `<${tag} class="${cls}" style="--w-delay:${idx * STAGGER}ms">${inner}</${tag}>`;
              idx++;
            } else if (m[0].startsWith('<br')) {
              out += '<br>';
            } else if (m[3]) {
              out += `<span class="stream-word" style="--w-delay:${idx * STAGGER}ms">${m[3]}</span>`;
              idx++;
            } else if (m[4]) {
              out += m[4];
            }
          }
          return out;
        }

        // Swap loading-state content with the real reply, replaying the bloom
        // animation so the bubble visibly enters with character (rotate + scale + blur).
        function popBubble(bubble, html) {
          // Drop the thinking-blob chrome (transparent bg) so the bubble background returns
          bubble.classList.remove('chat__msg--thinking');
          bubble.classList.remove('is-bloomed');

          // Reset any inline transforms left over
          bubble.style.transition = '';
          bubble.style.transform = '';

          bubble.innerHTML = html;

          // Force the bloom animation to restart with the new content inside
          bubble.style.animation = 'none';
          // eslint-disable-next-line no-unused-expressions
          bubble.offsetWidth;
          bubble.style.animation = 'chat-msg-bloom 660ms cubic-bezier(0.18, 1.16, 0.32, 1) both';

          // Freeze post-bloom so re-show doesn't replay anything
          setTimeout(() => {
            bubble.style.animation = '';
            bubble.classList.add('is-bloomed');
          }, 1800);
        }

        async function callLLM(messages, temperature) {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: MODEL, messages, temperature }),
          });
          if (!res.ok) throw new Error('API ' + res.status);
          const data = await res.json();
          return (data.choices?.[0]?.message?.content || '').trim();
        }

        // JS post-process — final safety net for em-dashes that survive
        function stripEmDashes(text) {
          return text
            .replace(/\s*—\s*/g, ', ')      // em-dash → comma
            .replace(/\s*–\s*/g, ', ')      // en-dash → comma
            .replace(/,\s*,/g, ',')          // collapse double commas
            .replace(/\s*,\s*([.!?])/g, '$1') // ", ." → "."
            .replace(/^\s*,\s*/, '')         // leading comma
            .trim();
        }

        // Full pipeline: draft → humanize → strip
        // ─────────────── VARIETY TRACKING ───────────────
        // Last 3 reply categories: 'word' | 'quiz' | 'fill' | 'prose'
        const recentReplyKinds = [];
        // Last 2 opener phrases (first 2 words), to avoid repeats
        const recentOpeners = [];

        function classifyReply(text) {
          const m = text.match(/<(word|quiz|fill|correct)\s/);
          return m ? m[1] : 'prose';
        }
        function getOpener(text) {
          const stripped = text.replace(/<[^>]+>/g, ' ').trim();
          const first = stripped.split(/[.!?\n]/)[0].trim();
          return first.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
        }

        // Build a small contextual hint to nudge the AI for variety / non-repetition
        function buildVarietyHint() {
          const hints = [];
          if (recentReplyKinds.length >= 2) {
            const last2 = recentReplyKinds.slice(-2);
            if (last2[0] !== 'prose' && last2[0] === last2[1]) {
              hints.push(`Your last two replies were both ${last2[0]} cards. Vary the format this turn — use prose or a different card type.`);
            }
          }
          if (recentOpeners.length > 0) {
            const last = recentOpeners[recentOpeners.length - 1];
            if (last) hints.push(`Do not start your reply with "${last}" again.`);
          }
          return hints.length ? `\n\n[Internal note: ${hints.join(' ')}]` : '';
        }

        // Stage 1 — classify the user's intent. Synthetic [Quiz result] / [Fill result]
        // events bypass the LLM call (the app injects them, no ambiguity to resolve).
        async function classifyScenario() {
          const lastUser = [...history].reverse().find((m) => m.role === 'user');
          if (!lastUser) return 'converse';
          const txt = lastUser.content || '';
          if (txt.startsWith('[Quiz result]') || txt.startsWith('[Fill result]')) {
            return 'result';
          }
          try {
            const out = await callLLM([
              { role: 'system', content: CLASSIFIER_SYSTEM },
              { role: 'user', content: txt },
            ], 0);
            const word = String(out || '').toLowerCase().trim().split(/\s+/)[0].replace(/[^a-z]/g, '');
            const valid = new Set(['correct', 'word', 'quiz', 'fill', 'converse']);
            return valid.has(word) ? word : 'converse';
          } catch (_) {
            return 'converse';
          }
        }

        // Stages 2-4: scenario-specific draft → humanize → em-dash strip.
        async function generateReply() {
          const scenario = await classifyScenario();
          const sysBase = SCENARIO_PROMPTS[scenario] || SCENARIO_CONVERSE;
          const sysWithVariety = sysBase + buildVarietyHint();

          const draft = await callLLM([
            { role: 'system', content: sysWithVariety },
            ...history.slice(-12),
          ], 0.85);
          if (!draft) throw new Error('Empty draft');

          let refined = draft;
          try {
            const r = await callLLM([
              { role: 'system', content: HUMANIZE_SYSTEM },
              { role: 'user', content: draft },
            ], 0.35);
            // Sanity check the rewrite — if too short or stripped tags, fall back
            if (r && r.length > 8 && countCardTags(r) === countCardTags(draft)) {
              refined = r;
            }
          } catch (_) {
            // Humanize failed — use the raw draft, em-dash strip will still apply
          }

          return stripEmDashes(refined);
        }

        function countCardTags(text) {
          const tags = ['word', 'quiz', 'fill', 'correct'];
          let n = 0;
          tags.forEach((t) => {
            const re = new RegExp(`<${t}\\s+[^>]*>`, 'g');
            n += (text.match(re) || []).length;
          });
          return n;
        }

        // ─────────────── REPAIR LAYER ───────────────
        // Auto-fixes common AI output issues without re-rolling the API call.
        function repairReply(text) {
          let out = text.trim();

          // 1) Word card examples: ensure target word is wrapped in <em> in each example's de attribute
          out = out.replace(/<word\s+([^>]+?)>([\s\S]*?)<\/word>/g, (match, attrsStr, inner) => {
            const deM = attrsStr.match(/de="([^"]+)"/);
            if (!deM) return match;
            const headword = deM[1];
            // Build a regex for the headword and any obvious inflection (gehe, ging, gegangen, etc.)
            const stem = headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 4);
            const wordRe = new RegExp(`\\b(${stem}\\w*)\\b`, 'i');

            const repairedInner = inner.replace(/<ex\s+de="([^"]*)"\s+en="([^"]*)"\s*\/?\s*>(?:<\/ex>)?/g, (m, deStr, enStr) => {
              if (/<em>[\s\S]+?<\/em>/.test(deStr)) return m; // already has an em, leave it
              const fixed = deStr.replace(wordRe, '<em>$1</em>');
              return `<ex de="${fixed}" en="${enStr}"/>`;
            });
            return `<word ${attrsStr}>${repairedInner}</word>`;
          });

          // 2) Prose-only replies: cap at 5 sentences (no card present)
          if (!/<(word|quiz|fill)\s/.test(out)) {
            const sentences = out.match(/[^.!?\n]+[.!?](?:\s|$)|[^.!?\n]+$/g) || [out];
            if (sentences.length > 5) {
              out = sentences.slice(0, 5).join('').trim();
            }
          }

          // 3) Quiz: strip duplicate options, clamp to 4 max
          out = out.replace(/<quiz\s+([^>]+?)>([\s\S]*?)<\/quiz>/g, (match, attrsStr, inner) => {
            const opts = [];
            const seen = new Set();
            const optRe = /<opt[^>]*>([\s\S]*?)<\/opt>/g;
            let m;
            while ((m = optRe.exec(inner)) !== null) {
              const key = m[1].trim().toLowerCase().replace(/<[^>]+>/g, '');
              if (key && !seen.has(key)) {
                seen.add(key);
                opts.push(m[1]);
              }
              if (opts.length >= 4) break;
            }
            if (opts.length < 2) return ''; // drop a busted quiz
            const optsHtml = opts.map((o) => `<opt>${o}</opt>`).join('');
            return `<quiz ${attrsStr}>${optsHtml}</quiz>`;
          });

          // 4) Fill: clamp blanks to 4 max, drop if <2
          out = out.replace(/<fill\s*([^>]*?)>([\s\S]*?)<\/fill>/g, (match, attrsStr, inner) => {
            const blanks = [];
            const blankRe = /<blank\s+[^>]*?\/?\s*>(?:<\/blank>)?/g;
            let m;
            while ((m = blankRe.exec(inner)) !== null) {
              blanks.push(m[0]);
              if (blanks.length >= 4) break;
            }
            if (blanks.length < 2) return ''; // drop a busted fill
            return `<fill ${attrsStr}>${blanks.join('')}</fill>`;
          });

          return out.trim();
        }

        // Detect malformed cards (open tag without matching close) — these are unusable
        function isMalformed(text) {
          for (const tag of ['word', 'quiz', 'fill', 'correct']) {
            const opens = (text.match(new RegExp(`<${tag}\\s`, 'g')) || []).length;
            const closes = (text.match(new RegExp(`</${tag}>`, 'g')) || []).length;
            if (opens !== closes) return true;
          }
          return false;
        }

        // Generate the full reply (non-streaming, two-pass humanize), then render
        // with a fake typewriter cascade and a springy bubble pop on content swap.
        async function generateAndRenderReply(aiMsg, retried = false) {
          let cleaned = await generateReply();

          // Validation gates
          if (!cleaned || isMalformed(cleaned)) {
            if (!retried) {
              // One retry on fatal issues (empty / malformed cards)
              return generateAndRenderReply(aiMsg, true);
            }
            throw new Error('Empty or malformed reply');
          }

          // Auto-repair common AI output issues
          cleaned = repairReply(cleaned);

          // Track variety/opener history for next turn's context hint
          recentReplyKinds.push(classifyReply(cleaned));
          if (recentReplyKinds.length > 5) recentReplyKinds.shift();
          const op = getOpener(cleaned);
          if (op) {
            recentOpeners.push(op);
            if (recentOpeners.length > 3) recentOpeners.shift();
          }

          history.push({ role: 'assistant', content: cleaned });

          const cardMatch = cleaned.match(/<(word|quiz|fill|correct)\s+[^>]*>[\s\S]*?<\/\1>/);
          if (cardMatch) {
            let intro = cleaned.slice(0, cardMatch.index).trim();
            const cardSegment = cardMatch[0];
            const cardKind = cardMatch[1]; // 'word' | 'quiz' | 'fill' | 'correct'

            // RULE: every card MUST have an intro bubble. Auto-generate one if AI skipped it.
            if (!intro) {
              intro = autoIntroForCard(cardKind, cardSegment);
            }

            popBubble(aiMsg, cascadeRichHtml(safeHtml(intro)));
            requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
            await sleep(640);

            const cardLoading = appendMessage('ai', '', { loading: true });
            await sleep(900);
            popBubble(cardLoading, safeHtml(cardSegment));
          } else {
            popBubble(aiMsg, cascadeRichHtml(safeHtml(cleaned)));
          }
        }

        // Auto-generated intro line if the AI sent a card with no lead-in.
        // Pulls the topic from the card itself so the intro feels relevant.
        function autoIntroForCard(kind, cardSegment) {
          if (kind === 'word') {
            const m = cardSegment.match(/de="([^"]+)"/);
            const word = m ? m[1] : 'the word';
            return `Here's <em>${word}</em>:`;
          }
          if (kind === 'quiz') return 'Quick check:';
          if (kind === 'fill') return 'Try these:';
          if (kind === 'correct') return "Let's clean that up:";
          return 'Here:';
        }

        async function sendMessage(text) {
          const trimmed = (text || '').trim();
          if (!trimmed) return;
          field.value = '';
          sendBtn.disabled = true;

          // User message — bubble pops in, words cascade with typewriter feel
          appendMessage('user', cascadeWords(trimmed));
          history.push({ role: 'user', content: trimmed });

          // Let the user message land before the AI starts thinking
          // (instant typing dots after sending feels robotic)
          await sleep(620);

          const aiMsg = appendMessage('ai', '', { loading: true });

          try {
            await generateAndRenderReply(aiMsg);
          } catch (err) {
            popBubble(aiMsg, 'Verbindungsfehler. Could not reach the tutor. Try again in a moment.');
          } finally {
            sendBtn.disabled = !field.value.trim();
            requestAnimationFrame(() => {
              messagesEl.scrollTop = messagesEl.scrollHeight;
              field.focus();
            });
          }
        }

        // Form submit
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          sendMessage(field.value);
        });

        // Enable send button when there's content + auto-grow the textarea up to a
        // soft cap. Height is animated via a critically-damped JS spring (no CSS
        // transition) so motion ramps up gradually instead of jolting on frame 1,
        // settles without overshoot, and re-targets cleanly mid-flight.
        const FIELD_MAX_HEIGHT = 160;       // px
        const SPRING_STIFFNESS = 180;       // higher = snappier
        const SPRING_DAMPING   = 26;        // ≈2*sqrt(stiffness) → critical damping
        const SPRING_MASS      = 1;
        const SPRING_REST_VEL  = 0.5;       // velocity threshold to snap-to-target
        const SPRING_REST_DIS  = 0.3;       // displacement threshold to snap-to-target

        let _fldFrame    = null;
        let _fldCurrent  = null;
        let _fldTarget   = null;
        let _fldVelocity = 0;
        let _fldLastTs   = 0;

        // Mirror-based height measurement, hot-path optimized:
        //   • Mirror styles are PRIMED ONCE (and on resize), not copied every keystroke.
        //     Eliminates the expensive getComputedStyle + 9 style writes per input event.
        //   • Width caches and only refreshes on viewport/layout changes.
        //   • Result memoized by value — typing the same characters never re-measures.
        let _fldMirror = null;
        let _fldMirrorPrimed = false;
        let _fldCachedWidth = 0;
        let _fldLastValue = null;
        let _fldLastHeight = 0;

        function getFieldMirror() {
          if (_fldMirror && _fldMirror.isConnected) return _fldMirror;
          const m = document.createElement('div');
          m.setAttribute('aria-hidden', 'true');
          m.style.position = 'absolute';
          m.style.visibility = 'hidden';
          m.style.pointerEvents = 'none';
          m.style.top = '0';
          m.style.left = '-99999px';
          m.style.whiteSpace = 'pre-wrap';
          m.style.wordBreak = 'break-word';
          m.style.overflowWrap = 'break-word';
          document.body.appendChild(m);
          _fldMirror = m;
          _fldMirrorPrimed = false; // re-prime on next measure
          return m;
        }

        function primeFieldMirror() {
          const m = getFieldMirror();
          const cs = window.getComputedStyle(field);
          m.style.fontFamily    = cs.fontFamily;
          m.style.fontSize      = cs.fontSize;
          m.style.fontWeight    = cs.fontWeight;
          m.style.lineHeight    = cs.lineHeight;
          m.style.letterSpacing = cs.letterSpacing;
          m.style.padding       = cs.padding;
          m.style.border        = cs.border;
          m.style.boxSizing     = cs.boxSizing;
          _fldCachedWidth = field.clientWidth;
          m.style.width = _fldCachedWidth + 'px';
          _fldMirrorPrimed = true;
          _fldLastValue = null; // invalidate result cache
        }

        function measureContentHeight() {
          if (!_fldMirrorPrimed) primeFieldMirror();
          const v = field.value;
          if (v === _fldLastValue) return _fldLastHeight;
          const m = getFieldMirror();
          m.textContent = v + ' '; // trailing space so a final \n counts
          _fldLastHeight = m.offsetHeight;
          _fldLastValue = v;
          return _fldLastHeight;
        }

        // Re-prime on viewport changes so width-dependent wrap stays accurate.
        let _fldResizeTimer = null;
        window.addEventListener('resize', () => {
          if (_fldResizeTimer) clearTimeout(_fldResizeTimer);
          _fldResizeTimer = setTimeout(() => {
            if (field.clientWidth !== _fldCachedWidth) primeFieldMirror();
          }, 120);
        });

        function fieldTick(ts) {
          // Real frame delta in seconds, clamped so a backgrounded tab doesn't spiral
          // when it resumes (a 5-second jump would integrate to chaos).
          const dt = Math.min(0.032, _fldLastTs ? (ts - _fldLastTs) / 1000 : 1 / 60);
          _fldLastTs = ts;

          const displacement = _fldCurrent - _fldTarget;
          const springForce  = -SPRING_STIFFNESS * displacement;
          const dampForce    = -SPRING_DAMPING * _fldVelocity;
          const accel        = (springForce + dampForce) / SPRING_MASS;
          _fldVelocity += accel * dt;
          _fldCurrent  += _fldVelocity * dt;

          if (Math.abs(displacement) < SPRING_REST_DIS && Math.abs(_fldVelocity) < SPRING_REST_VEL) {
            _fldCurrent  = _fldTarget;
            _fldVelocity = 0;
            field.style.height = _fldCurrent + 'px';
            _fldFrame  = null;
            _fldLastTs = 0;
            return;
          }
          field.style.height = _fldCurrent + 'px';
          _fldFrame = requestAnimationFrame(fieldTick);
        }

        function autoGrowField() {
          const target = Math.min(measureContentHeight(), FIELD_MAX_HEIGHT);
          if (_fldCurrent === null) {
            _fldCurrent = field.getBoundingClientRect().height || target;
          }
          // Skip if target unchanged AND we're already settled — no work to do.
          if (target === _fldTarget && _fldFrame === null && Math.abs(_fldCurrent - target) < 0.5) {
            return;
          }
          _fldTarget = target;
          if (_fldFrame === null) {
            _fldLastTs = 0;
            _fldFrame  = requestAnimationFrame(fieldTick);
          }
        }
        // Auto-markdown: at the start of a line, "- X" or "* X" (X = first real character
        // typed after the space) converts to "  • X". The 2 leading spaces give the bullet
        // a visual offset from the left, mirroring how a real list renders. We wait for the
        // first non-whitespace char so an unfinished "- " isn't molested.
        const BULLET = '  • ';
        function applyBulletShortcut() {
          const v = field.value;
          const pos = field.selectionStart;
          if (pos < 3) return;
          const last = v[pos - 1];
          // Need a real character just typed — not a space, not a newline
          if (!last || /\s/.test(last)) return;
          const prefix = v.slice(pos - 3, pos - 1);
          if (prefix !== '- ' && prefix !== '* ') return;
          // The "- " must sit at the start of a line
          const charBefore = pos >= 4 ? v[pos - 4] : '';
          if (pos !== 3 && charBefore !== '\n') return;
          // Replace "- X" (3 chars) with "  • X" (5 chars) — caret drifts +2
          field.value = v.slice(0, pos - 3) + BULLET + v.slice(pos - 1);
          field.selectionStart = field.selectionEnd = pos + 2;
        }

        // List continuation: Shift+Enter on a "  • " line inserts a fresh bullet on the next
        // line. If the current bullet is empty, exit the list instead (strip the prefix).
        // Returns true if it handled the event so the caller can trigger autoGrow.
        function handleListContinuation(e) {
          const v = field.value;
          const pos = field.selectionStart;
          const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
          const lineEnd = v.indexOf('\n', pos);
          const line = v.slice(lineStart, lineEnd === -1 ? v.length : lineEnd);
          if (!line.startsWith(BULLET)) return false;
          const rest = line.slice(BULLET.length).trim();
          e.preventDefault();
          if (rest === '') {
            // Empty bullet → exit list, strip the prefix
            field.value = v.slice(0, lineStart) + v.slice(lineStart + BULLET.length);
            field.selectionStart = field.selectionEnd = lineStart;
          } else {
            const insert = '\n' + BULLET;
            field.value = v.slice(0, pos) + insert + v.slice(pos);
            field.selectionStart = field.selectionEnd = pos + insert.length;
          }
          return true;
        }

        field.addEventListener('input', () => {
          applyBulletShortcut();
          sendBtn.disabled = !field.value.trim();
          autoGrowField();
        });

        // Enter sends; Shift+Enter inserts a newline (or continues a bullet list).
        field.addEventListener('keydown', (e) => {
          if (e.isComposing || e.key !== 'Enter') return;
          if (!e.shiftKey) {
            e.preventDefault();
            sendMessage(field.value);
            requestAnimationFrame(autoGrowField);
            return;
          }
          if (handleListContinuation(e)) {
            sendBtn.disabled = !field.value.trim();
            requestAnimationFrame(autoGrowField);
          }
        });

        // Trigger an AI follow-up turn (used after quiz/fill completes)
        async function runAIFollowUp() {
          const loading = appendMessage('ai', '', { loading: true });
          try {
            await generateAndRenderReply(loading);
          } catch (err) {
            popBubble(loading, 'Verbindungsfehler. Could not fetch a follow-up. Try sending a message.');
          } finally {
            requestAnimationFrame(() => {
              messagesEl.scrollTop = messagesEl.scrollHeight;
            });
          }
        }

        // ─── Custom fill dropdown — toggle, select, outside-click ───
        document.addEventListener('click', (e) => {
          // Close any open fill dropdowns when clicking outside
          const openDD = document.querySelector('.fill__dd-btn[aria-expanded="true"]');
          if (openDD && !e.target.closest('.fill__dd')) {
            openDD.setAttribute('aria-expanded', 'false');
            const menu = openDD.parentElement.querySelector('.fill__dd-menu');
            if (menu) menu.hidden = true;
          }
        });

        // Interactive card handlers — delegated at messagesEl
        messagesEl.addEventListener('click', (e) => {
          // Custom fill dropdown — toggle
          const ddBtn = e.target.closest('.fill__dd-btn');
          if (ddBtn) {
            const dd = ddBtn.closest('.fill__dd');
            const menu = dd.querySelector('.fill__dd-menu');
            const expanded = ddBtn.getAttribute('aria-expanded') === 'true';
            // Close other open dropdowns
            document.querySelectorAll('.fill__dd-btn[aria-expanded="true"]').forEach((b) => {
              if (b !== ddBtn) {
                b.setAttribute('aria-expanded', 'false');
                const m = b.parentElement.querySelector('.fill__dd-menu');
                if (m) m.hidden = true;
              }
            });
            ddBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            menu.hidden = expanded;
            return;
          }
          // Custom fill dropdown — option pick
          const ddOpt = e.target.closest('.fill__dd-opt');
          if (ddOpt) {
            const dd = ddOpt.closest('.fill__dd');
            const btn = dd.querySelector('.fill__dd-btn');
            const valueEl = dd.querySelector('.fill__dd-value');
            const menu = dd.querySelector('.fill__dd-menu');
            const val = ddOpt.dataset.val;
            dd.dataset.value = val;
            valueEl.textContent = val;
            valueEl.classList.remove('is-empty');
            // Mark selected
            dd.querySelectorAll('.fill__dd-opt').forEach((o) => o.classList.toggle('is-selected', o === ddOpt));
            // Close menu
            btn.setAttribute('aria-expanded', 'false');
            menu.hidden = true;
            return;
          }

          // Quiz option click
          const opt = e.target.closest('.quiz__opt');
          if (opt) {
            const quiz = opt.closest('.quiz');
            if (!quiz || quiz.classList.contains('is-answered')) return;

            const correct = parseInt(quiz.dataset.answer, 10);
            const picked  = parseInt(opt.dataset.idx, 10);
            quiz.classList.add('is-answered');

            quiz.querySelectorAll('.quiz__opt').forEach((o) => {
              if (parseInt(o.dataset.idx, 10) === correct) o.classList.add('is-correct');
            });
            opt.classList.add('is-picked');
            if (picked !== correct) opt.classList.add('is-wrong');

            const correctOpt = quiz.querySelector(`.quiz__opt[data-idx="${correct}"] .quiz__opt-text`);
            const correctText = correctOpt ? correctOpt.textContent : '';
            const pickedText  = opt.querySelector('.quiz__opt-text').textContent;
            const letter = String.fromCharCode(64 + picked);
            const isRight = picked === correct;

            // Visible user bubble — letter in a black rounded chip + the answer text
            const visibleAnswer = `<span class="answer-row"><span class="answer-letter">${letter}</span><span>${escapeText(pickedText)}</span></span>`;
            appendMessage('user', visibleAnswer);

            history.push({
              role: 'user',
              content: `[Quiz result] Question: "${quiz.dataset.q}". I picked: "${pickedText}". ${isRight ? 'Correct.' : 'Incorrect — the right answer was: "' + correctText + '".'}`,
            });
            // Trigger AI follow-up after a brief pause (let user see the feedback first)
            setTimeout(runAIFollowUp, 700);
            return;
          }

          // Fill check click
          const check = e.target.closest('.fill__check');
          if (check && !check.disabled) {
            const fill = check.closest('.fill');
            if (!fill) return;
            const rows = fill.querySelectorAll('.fill__row');
            let correctCount = 0;
            const wrongs = [];

            rows.forEach((row) => {
              const dd = row.querySelector('.fill__dd');
              const input = row.querySelector('.fill__input');
              const userVal = dd ? (dd.dataset.value || '') : ((input && input.value) || '').trim();
              const correctVal = row.dataset.answer || '';
              if (userVal && userVal.toLowerCase() === correctVal.toLowerCase()) {
                row.classList.add('is-correct');
                correctCount++;
              } else {
                row.classList.add('is-wrong');
                if (!row.querySelector('.fill__hint')) {
                  const hint = document.createElement('span');
                  hint.className = 'fill__hint';
                  hint.innerHTML = '→ <strong>' + correctVal.replace(/[<>]/g, '') + '</strong>';
                  row.appendChild(hint);
                }
                wrongs.push({ user: userVal || '(blank)', correct: correctVal });
              }
              if (input) input.disabled = true;
              if (dd) {
                const ddBtn = dd.querySelector('.fill__dd-btn');
                if (ddBtn) {
                  ddBtn.disabled = true;
                  ddBtn.style.cursor = 'default';
                  ddBtn.style.pointerEvents = 'none';
                }
              }
            });

            if (!fill.querySelector('.fill__score')) {
              const score = document.createElement('p');
              score.className = 'fill__score';
              score.innerHTML = `<strong>${correctCount} / ${rows.length}</strong> correct`;
              fill.appendChild(score);
            }

            check.disabled = true;
            check.textContent = 'Checked';

            let summary = `[Fill result] ${correctCount}/${rows.length} correct.`;
            if (wrongs.length > 0) {
              summary += ' Mistakes: ' + wrongs.map((w) => `wrote "${w.user}" → correct "${w.correct}"`).join('; ');
            }

            // Visible user bubble — score for fill cards (multiple blanks at once)
            const visibleAnswer = `<span class="answer-row"><span class="answer-letter">✓</span><span>${correctCount} / ${rows.length} correct</span></span>`;
            appendMessage('user', visibleAnswer);

            history.push({ role: 'user', content: summary });
            setTimeout(runAIFollowUp, 700);
            return;
          }
        });

        // ─────────── CLICKABLE GERMAN WORDS — quick-info popover ───────────
        const wordInfoCache = new Map();

        async function fetchWordInfo(word) {
          const key = word.toLowerCase().trim();
          if (wordInfoCache.has(key)) return wordInfoCache.get(key);

          const sys = `You output ONLY a single self-closing <word/> tag with grammar info for the given German word. No prose, no explanation, no surrounding text.

Schema:
<word de="WORD" en="2-4 word English meaning" type="noun|verb|adjective|adverb|phrase" article="der|die|das|" plural="" past="" perfect="" auxiliary="haben|sein" comparative="" superlative=""/>

Required by type:
- noun: include article + plural
- verb: include past (Präteritum 3.Sg) + perfect (full e.g. "hat gemacht") + auxiliary
- adjective: include comparative + superlative ("am ___sten")
- adverb / phrase: just de + en + type

Output ONLY the tag. Nothing else.`;

          try {
            const res = await fetch(API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: MODEL,
                messages: [
                  { role: 'system', content: sys },
                  { role: 'user', content: word },
                ],
                temperature: 0.2,
              }),
            });
            if (!res.ok) throw new Error('API ' + res.status);
            const data = await res.json();
            const reply = (data.choices?.[0]?.message?.content || '').trim();
            const m = reply.match(/<word\s+([^>]+?)\s*\/?\s*>/);
            if (!m) throw new Error('no tag');
            const attrs = parseAttrs(m[1]);
            wordInfoCache.set(key, attrs);
            return attrs;
          } catch (e) {
            return null;
          }
        }

        function renderChipInfo(attrs) {
          const article = attrs.article || '';
          const de      = attrs.de || '';
          const en      = attrs.en || '';
          const type    = (attrs.type || '').toLowerCase();

          let typeLabel = '';
          if (type === 'noun') {
            typeLabel = article === 'die' ? 'feminine noun'
                      : article === 'der' ? 'masculine noun'
                      : article === 'das' ? 'neuter noun'
                      : 'noun';
          } else if (type) {
            typeLabel = type;
          }

          const extras = [];
          if (attrs.plural)      extras.push(`plural <strong>${escapeText((article ? 'die ' : '') + attrs.plural)}</strong>`);
          if (attrs.past)        extras.push(`Präteritum <strong>${escapeText(attrs.past)}</strong>`);
          if (attrs.perfect)     extras.push(`Perfekt <strong>${escapeText(attrs.perfect)}</strong>`);
          if (attrs.auxiliary)   extras.push(`aux <strong>${escapeText(attrs.auxiliary)}</strong>`);
          if (attrs.comparative) extras.push(`comp. <strong>${escapeText(attrs.comparative)}</strong>`);
          if (attrs.superlative) extras.push(`sup. <strong>${escapeText(attrs.superlative)}</strong>`);

          let html = '<div class="chip-pop__head">';
          if (article) html += `<span class="chip-pop__article">${escapeText(article)}</span>`;
          html += `<span class="chip-pop__de">${escapeText(de)}</span>`;
          html += '</div>';
          if (typeLabel) html += `<p class="chip-pop__type">${escapeText(typeLabel)}</p>`;
          if (en)        html += `<p class="chip-pop__meaning">${escapeText(en)}</p>`;
          if (extras.length) html += `<p class="chip-pop__extra">${extras.join(' · ')}</p>`;
          return html;
        }

        function placeChipPop(pop, target) {
          const r = target.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top - 8; // 8px gap above the word
          pop.style.left = cx + 'px';
          pop.style.top  = cy + 'px';
        }

        function dismissChipPops() {
          document.querySelectorAll('.chip-pop').forEach((p) => p.remove());
        }

        async function showChipPop(target) {
          dismissChipPops();
          const word = target.textContent.trim();
          if (!word) return;

          const pop = document.createElement('div');
          pop.className = 'chip-pop';
          pop.innerHTML =
            '<span class="chip-pop__loading">' +
              '<strong>' + escapeText(word) + '</strong>' +
              '<span class="chip-pop__loading-dots"><span></span><span></span><span></span></span>' +
            '</span>';
          document.body.appendChild(pop);
          placeChipPop(pop, target);

          // Click outside / scroll closes the popover
          const onAway = (e) => {
            if (e && e.type === 'click' && e.target.closest('.chip-pop')) return;
            cleanup();
          };
          const cleanup = () => {
            document.removeEventListener('click', onAway, true);
            window.removeEventListener('scroll', onAway, true);
            window.removeEventListener('resize', onAway, true);
            messagesEl.removeEventListener('scroll', onAway, true);
            dismissChipPops();
          };
          setTimeout(() => {
            document.addEventListener('click', onAway, true);
            window.addEventListener('scroll', onAway, true);
            window.addEventListener('resize', onAway, true);
            messagesEl.addEventListener('scroll', onAway, true);
          }, 0);

          const info = await fetchWordInfo(word);
          // The pop may have been dismissed during the await; bail out if so
          if (!document.body.contains(pop)) return;
          if (!info || !info.de) {
            pop.innerHTML = '<span class="chip-pop__error">Could not look up <strong>' + escapeText(word) + '</strong>.</span>';
            return;
          }
          pop.innerHTML = renderChipInfo(info);
          placeChipPop(pop, target);
        }

        // Delegated click handler — chat <em> + word-card example <mark>
        document.addEventListener('click', (e) => {
          const target = e.target.closest(
            '.chat__msg em, .word-card__ex-de mark'
          );
          if (!target) return;
          e.stopPropagation();
          e.preventDefault();
          showChipPop(target);
        });

        // Focus the input when the chat view is opened
        window.__focusChat = function () {
          if (field) field.focus();
        };
      })();

      // ===================================================================
      // PAUSE TTS when tab loses visibility — no orphan audio playback
      // ===================================================================
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && typeof stopSpeaking === 'function') {
          try { stopSpeaking(); } catch (_) {}
        }
      });

    })();
