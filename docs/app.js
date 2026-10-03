// clipcmd website: a live demo of the buttons, copy buttons, and scroll reveals.
// The demo copies exactly what clipcmd copies: [COPY CMD] the command, [COPY OUTPUT]
// the output as plain text, [COPY BOTH] "$ command" + output, [+] the collection.
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ copying
  const tag = document.getElementById('copied-tag');
  const tagText = document.getElementById('copied-text');
  let tagTimer = 0;

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Older browsers, or a page without clipboard permission
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      return ok;
    }
  }

  // The "✓ Copied" tag next to the pointer, like clipcmd's own on Windows
  function showTag(message, event, target) {
    tagText.textContent = message;
    tag.hidden = false;
    let x, y;
    if (event && event.clientX) {
      x = event.clientX + 16;
      y = event.clientY + 18;
    } else {
      const r = target.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 8;
    }
    const w = tag.offsetWidth || 240;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - 52));
    tag.style.left = x + 'px';
    tag.style.top = y + 'px';
    requestAnimationFrame(function () { tag.classList.add('show'); });
    clearTimeout(tagTimer);
    tagTimer = setTimeout(function () {
      tag.classList.remove('show');
      tagTimer = setTimeout(function () { tag.hidden = true; }, 200);
    }, 1400);
  }

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', async function (event) {
      const ok = await copyText(button.dataset.copy);
      showTag(ok ? button.dataset.label || 'Copied' : 'Press Ctrl+C to copy', event, button);
    });
  });

  // ------------------------------------------------------------------ demo data
  const PROMPTS = {
    powershell: [['PS C:\\projects\\api> ']],
    bash: [['dev@laptop', 'c-green'], [':'], ['~/projects/api', 'c-cyan'], ['$ ']],
    zsh: [['~/projects/api ', 'c-cyan'], ['❯ ', 'c-green']],
    fish: [['dev@laptop ', 'c-green'], ['~/p/api', 'c-cyan'], ['> ']],
  };
  // Each output line is a list of [text, class] segments
  const COMMANDS = [
    {
      cmd: 'git status',
      out: [
        [['On branch main']],
        [["Your branch is up to date with 'origin/main'."]],
        [['']],
        [['Changes not staged for commit:']],
        [['        modified:   src/cart.ts', 'c-red']],
      ],
    },
    {
      cmd: 'npm run build',
      out: [
        [['> api@1.4.0 build']],
        [['> tsc -p .']],
        [['']],
        [['src/cart.ts', 'c-cyan'], [':'], ['42', 'c-yel'], [':'], ['17', 'c-yel'], [' - '], ['error', 'c-red'], [' TS2304: ', 'c-dim'], ["Cannot find name 'discount'."]],
        [['']],
        [['42   return subtotal * (1 - discount);']],
        [['                            '], ['~~~~~~~~', 'c-red']],
        [['']],
        [['Found 1 error in src/cart.ts:42']],
      ],
    },
  ];
  const plain = (line) => line.map((s) => s[0]).join('');
  const outputOf = (c) => c.out.map(plain).join('\n');

  // ------------------------------------------------------------------ the terminal
  const body = document.getElementById('term-body');
  const tabs = document.querySelectorAll('.term-tab');
  const replay = document.querySelector('.term-replay');
  let shell = 'powershell';
  let run = 0; // cancels a running playback
  const blocks = []; // commands shown so far, oldest first
  const selected = new Set();

  function seg(parent, text, cls) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    parent.appendChild(span);
    return span;
  }
  function newLine() {
    const div = document.createElement('div');
    div.className = 'line';
    body.appendChild(div);
    return div;
  }
  function prompt(line) {
    PROMPTS[shell].forEach(function (p) { seg(line, p[0], p[1]); });
  }
  function scrollDown() { body.scrollTop = body.scrollHeight; }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduceMotion ? 0 : ms));

  function buttonsFor(block) {
    const row = newLine();
    row.classList.add('tbtns');
    if (!reduceMotion) row.classList.add('fresh');
    const make = (label, title, handler) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tbtn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', handler);
      row.appendChild(b);
      return b;
    };
    make('[COPY CMD]', 'Copy the command', async function (e) {
      await copyText(block.cmd);
      showTag('Copied command', e, this);
    });
    make('[COPY OUTPUT]', 'Copy the output', async function (e) {
      await copyText(outputOf(block));
      showTag('Copied output', e, this);
    });
    make('[COPY BOTH]', 'Copy "$ command" and its output', async function (e) {
      await copyText('$ ' + block.cmd + '\n' + outputOf(block));
      showTag('Copied command + output', e, this);
    });
    block.plus = make('[+]', 'Add to (or remove from) the collection', async function (e) {
      const added = !selected.has(block);
      if (added) selected.add(block); else selected.delete(block);
      block.plus.classList.toggle('selected', added);
      const list = blocks.filter((b) => selected.has(b));
      const count = list.length + ' command' + (list.length === 1 ? '' : 's');
      if (list.length) await copyText(list.map((b) => '$ ' + b.cmd + '\n' + outputOf(b) + '\n\n').join(''));
      showTag(added ? 'Collected: ' + count + ' copied' : 'Removed: ' + count + ' left', e, this);
    });
  }

  async function play() {
    const token = ++run;
    body.textContent = '';
    blocks.length = 0;
    selected.clear();
    for (const c of COMMANDS) {
      const line = newLine();
      prompt(line);
      const typed = seg(line, '', 'c-cmd');
      const rest = seg(line, '');
      const [word, ...args] = c.cmd.split(' ');
      const tail = args.length ? ' ' + args.join(' ') : '';
      for (let i = 1; i <= c.cmd.length; i++) {
        if (token !== run) return;
        typed.textContent = c.cmd.slice(0, Math.min(i, word.length));
        rest.textContent = i > word.length ? tail.slice(0, i - word.length) : '';
        await wait(55);
      }
      await wait(350);
      for (const outLine of c.out) {
        if (token !== run) return;
        const l = newLine();
        outLine.forEach(function (s) { seg(l, s[0], s[1]); });
        scrollDown();
        await wait(70);
      }
      if (token !== run) return;
      const block = { cmd: c.cmd, out: c.out };
      blocks.push(block);
      buttonsFor(block);
      scrollDown();
      await wait(1500);
    }
    if (token !== run) return;
    const last = newLine();
    prompt(last);
    seg(last, '', 'caret');
    scrollDown();
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
      shell = tab.dataset.shell;
      play();
    });
  });
  replay.addEventListener('click', play);

  // Start the demo when it scrolls into view (it is in the hero, so usually at once)
  if ('IntersectionObserver' in window) {
    const once = new IntersectionObserver(function (entries) {
      if (entries.some((e) => e.isIntersecting)) {
        once.disconnect();
        play();
      }
    });
    once.observe(body);
  } else {
    play();
  }

  // ------------------------------------------------------------------ the agent box
  const box = document.getElementById('agent-box');
  const meta = document.getElementById('agent-meta');
  const defaultMeta = meta.textContent;
  function describe() {
    const text = box.value.replace(/\s+$/, '');
    if (!text) {
      meta.textContent = defaultMeta;
      meta.classList.remove('ok');
      return;
    }
    const lines = text.split('\n').length;
    meta.textContent = '✓ ' + lines + ' line' + (lines === 1 ? '' : 's') + ', complete: exactly what your AI agent receives.';
    meta.classList.add('ok');
  }
  box.addEventListener('input', describe);
  document.querySelector('.agent-clear').addEventListener('click', function () {
    box.value = '';
    describe();
    box.focus();
  });

  // ------------------------------------------------------------------ scroll reveals
  const reveals = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }
})();
