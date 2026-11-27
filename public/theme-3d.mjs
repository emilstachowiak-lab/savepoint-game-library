const shellColors = {
  Nintendo: 'rgb(228, 0, 18)',
  Sega: 'rgb(0, 51, 126)',
  Sony: 'rgb(0, 112, 204)',
  Microsoft: 'rgb(155, 240, 11)',
  Other: 'rgb(20, 20, 20)'
};

const legacyAliases = {
  Nintendo: [
    'Nintendo Entertainment System', 'Famicom', 'Family Computer',
    'Super Nintendo Entertainment System', 'Super Nintendo', 'Super Famicom',
    'GB', 'GBC', 'GBA', 'N64', 'Nintendo GameCube', 'GCN',
    'NDS', 'DS', '3DS', 'Nintendo 2DS', '2DS', 'New Nintendo 3DS',
    'Switch', 'Switch 2', 'Switch Lite', 'Nintendo Switch Lite', 'Switch OLED', 'Nintendo Switch OLED'
  ],
  Sega: [
    'Sega SG-1000', 'Sega Master System', 'Sega Mega Drive/Genesis', 'Mega Drive',
    'Genesis', 'Sega Mega Drive', 'Sega Genesis', 'Sega Game Gear',
    'Sega CD', 'Mega-CD', 'Sega Mega CD', 'Sega 32X', 'Saturn', 'Sega Dreamcast', 'Pico'
  ],
  Sony: [
    'PS', 'PS1', 'PS2', 'PS3', 'PS4', 'PS5', 'PSX', 'PSone', 'PlayStation 1',
    'PlayStation 4 Pro', 'PlayStation 5 Pro', 'PS4 Pro', 'PS5 Pro',
    'PlayStation Portable', 'PS Vita', 'Vita', 'PlayStation TV'
  ],
  Microsoft: [
    'Original Xbox', 'Microsoft Xbox', 'Microsoft Xbox 360', 'Microsoft Xbox One',
    'Microsoft Xbox Series', 'Xbox One X', 'Xbox One S', 'Xbox Series X|S',
    'Xbox Series X/S', 'Xbox Series X', 'Xbox Series S'
  ]
};

const slots = [
  { x: 0, y: 0, scale: 1, angle: 0, light: 1.05 },
  { x: 122, y: 19, scale: .87, angle: 35, light: .90 },
  { x: 166, y: 24, scale: .84, angle: 43, light: .80 },
  { x: 202, y: 29, scale: .81, angle: 51, light: .71 },
  { x: 232, y: 33, scale: .79, angle: 55, light: .64 }
];

const platformKey = label => label.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function platformBrandResolver(groups) {
  const brands = new Map();
  for (const [brand, aliases] of Object.entries(legacyAliases)) {
    for (const alias of aliases) brands.set(platformKey(alias), brand);
  }
  // The existing game form owns the current list of console manufacturers.
  for (const { name, inputs } of groups) {
    if (!Object.hasOwn(legacyAliases, name)) continue;
    for (const { value } of inputs) brands.set(platformKey(value), name);
  }
  return platform => brands.get(platformKey(platform)) || 'Other';
}

function paintReflection(canvas, image) {
  const ready = Boolean(image.complete && image.naturalWidth && image.naturalHeight);
  image.dataset.ready = String(ready);
  canvas.hidden = !ready;
  if (!ready) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

function createCase(entry, renderCover) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme3d-case';
  button.dataset.gameId = String(entry.game.id);
  button.setAttribute('aria-label', entry.game.title);
  button.innerHTML = `
    <span class="theme3d-halo" aria-hidden="true"></span>
    <span class="theme3d-object" aria-hidden="true">
      <span class="theme3d-side"></span><span class="theme3d-side theme3d-side-right"></span>
      <span class="theme3d-top"></span>
      <span class="theme3d-face">
        <span class="theme3d-band"></span>
        <span class="theme3d-print">${entry.coverUrl ? renderCover(entry) : ''}
          <span class="theme3d-cover-title"></span>
        </span>
      </span>
      <span class="theme3d-reflection"><canvas class="theme3d-reflection-art" width="144" height="188" hidden></canvas></span>
    </span>`;
  for (const side of button.querySelectorAll('.theme3d-side')) side.dataset.spine = entry.game.title;
  button.querySelector('.theme3d-cover-title').textContent = entry.game.title;
  const image = button.querySelector('img.cover-image');
  if (image) {
    image.classList.add('theme3d-image');
    const canvas = button.querySelector('canvas');
    // Paint the decoded cover beneath the case without another network request.
    const reflect = () => paintReflection(canvas, image);
    image.addEventListener('load', reflect);
    image.addEventListener('error', reflect);
    reflect();
  }
  return { button, image, band: button.querySelector('.theme3d-band') };
}

export function createCoverflow({
  grid, renderCover, uiText, gameLabel, icon, getPlatformGroups,
  setPlatformFilter, trackCoverImages, privateViewUsable
}) {
  const brandForPlatform = platformBrandResolver(getPlatformGroups());
  const region = document.createElement('section');
  region.className = 'theme3d-library';
  region.innerHTML = `
    <div class="theme3d-platforms" role="group"></div>
    <div class="theme3d-stage">
      <div class="theme3d-shelf"></div>
      <div class="theme3d-selection" aria-live="polite" aria-atomic="true">
        <h2 class="theme3d-title" dir="auto"></h2><p class="theme3d-meta"></p>
      </div>
    </div>
    <div class="theme3d-footer">
      <div class="theme3d-navigation" role="group">
        <button class="theme3d-arrow" type="button" data-step="-1"><span aria-hidden="true">‹</span></button>
        <output class="theme3d-position" aria-live="off"></output>
        <button class="theme3d-arrow" type="button" data-step="1"><span aria-hidden="true">›</span></button>
      </div>
      <div class="theme3d-actions">
        <button class="theme3d-action" type="button" data-game-action="edit">${icon('pencil')}<span></span></button>
        <button class="theme3d-action" type="button" data-game-action="delete">${icon('trash-2')}<span></span></button>
      </div>
    </div>`;
  grid.replaceChildren(region);

  const platformGroup = region.querySelector('.theme3d-platforms');
  const shelf = region.querySelector('.theme3d-shelf');
  const heading = region.querySelector('.theme3d-title');
  const meta = region.querySelector('.theme3d-meta');
  const navigation = region.querySelector('.theme3d-navigation');
  const position = region.querySelector('.theme3d-position');
  const prev = region.querySelector('[data-step="-1"]');
  const next = region.querySelector('[data-step="1"]');
  const edit = region.querySelector('[data-game-action="edit"]');
  const remove = region.querySelector('[data-game-action="delete"]');
  const slides = new Map();
  let renderedPlatforms;
  let entries = [];
  let index = 0;
  let currentPlatform = '';
  let gesture;
  let ignoreClickUntil = 0;

  function updatePlatforms(platforms) {
    if (platforms !== renderedPlatforms) {
      const buttons = ['', ...platforms].map(platform => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.theme3dPlatform = platform;
        button.textContent = platform ? gameLabel('platform', platform) : uiText('Wszystkie', 'All');
        return button;
      });
      const focusedPlatform = platformGroup.contains(document.activeElement)
        ? document.activeElement.dataset.theme3dPlatform : undefined;
      platformGroup.replaceChildren(...buttons);
      if (focusedPlatform !== undefined) {
        buttons.find(button => button.dataset.theme3dPlatform === focusedPlatform)?.focus({ preventScroll: true });
      }
      renderedPlatforms = platforms;
    }
    for (const button of platformGroup.children) {
      button.setAttribute('aria-pressed', String(button.dataset.theme3dPlatform === currentPlatform));
    }
  }

  function updateLabels(entry, platform) {
    const { game } = entry;
    const gameId = String(game.id);
    region.setAttribute('aria-label', uiText('Biblioteka 3D', '3D library'));
    platformGroup.setAttribute('aria-label', uiText('Filtruj po konsoli', 'Filter by console'));
    navigation.setAttribute('aria-label', uiText('Przeglądaj gry', 'Browse games'));
    prev.setAttribute('aria-label', uiText('Poprzednia gra', 'Previous game'));
    next.setAttribute('aria-label', uiText('Następna gra', 'Next game'));
    position.setAttribute('aria-label', uiText('Pozycja w bibliotece', 'Position in library'));
    prev.disabled = next.disabled = entries.length === 1;
    position.textContent = `${index + 1} / ${entries.length}`;
    heading.textContent = game.title;
    meta.textContent = [
      platform ? gameLabel('platform', platform) : '',
      gameLabel('edition', game.edition || 'Fizyczne'),
      gameLabel('status', game.status || 'Do ogrania')
    ].filter(Boolean).join(' · ');
    edit.dataset.gameId = remove.dataset.gameId = gameId;
    edit.lastElementChild.textContent = uiText('Edytuj', 'Edit');
    remove.lastElementChild.textContent = uiText('Usuń', 'Delete');
    edit.setAttribute('aria-label', `${uiText('Edytuj', 'Edit')} ${game.title}`);
    remove.setAttribute('aria-label', `${uiText('Usuń', 'Delete')} ${game.title}`);
  }

  function draw() {
    const count = Math.min(entries.length, 2 * slots.length - 1);
    const before = Math.floor((count - 1) / 2);
    const windowEntries = Array.from({ length: count }, (_, offset) => {
      const relative = offset - before;
      return { entry: entries[(index + relative + entries.length) % entries.length], relative };
    });
    const wanted = new Set(windowEntries.map(({ entry }) => entry));
    for (const [entry, slide] of slides) {
      if (wanted.has(entry)) continue;
      slide.button.remove();
      slides.delete(entry);
    }
    for (const [order, { entry, relative }] of windowEntries.entries()) {
      let slide = slides.get(entry);
      if (!slide) {
        slide = createCase(entry, renderCover);
        slides.set(entry, slide);
      }
      const { button, band, image } = slide;
      const active = relative === 0;
      const platform = currentPlatform || entry.platforms[0] || '';
      const brand = brandForPlatform(platform);
      const distance = Math.abs(relative);
      const side = Math.sign(relative);
      const slot = slots[distance];
      button.dataset.distance = String(distance);
      button.setAttribute('aria-current', String(active));
      button.tabIndex = active ? 0 : -1;
      button.style.setProperty('--case-offset', `${slot.x * side}%`);
      button.style.setProperty('--case-drop', `${slot.y}px`);
      button.style.setProperty('--case-scale', slot.scale);
      button.style.setProperty('--case-angle', `${-slot.angle * side}deg`);
      button.style.setProperty('--case-light', slot.light);
      button.style.setProperty('--case-shell', shellColors[brand]);
      if (brand === 'Microsoft') button.style.setProperty('--case-ink', '#101804');
      else button.style.removeProperty('--case-ink');
      button.style.zIndex = String(slots.length - distance);
      band.textContent = platform ? gameLabel('platform', platform) : uiText('Inna', 'Other');
      if (active && image) image.loading = 'eager';
      const mounted = shelf.children[order] || null;
      if (mounted !== button) shelf.insertBefore(button, mounted);
      if (active) updateLabels(entry, platform);
    }
    trackCoverImages();
  }

  function move(target, focusCase = false) {
    if (!privateViewUsable() || entries.length < 2) return;
    index = (target + entries.length) % entries.length;
    draw();
    if (focusCase) slides.get(entries[index]).button.focus({ preventScroll: true });
  }

  platformGroup.addEventListener('click', event => {
    const button = event.target.closest('[data-theme3d-platform]');
    if (button && privateViewUsable()) setPlatformFilter(button.dataset.theme3dPlatform);
  });
  prev.addEventListener('click', () => move(index - 1));
  next.addEventListener('click', () => move(index + 1));
  shelf.addEventListener('click', event => {
    const button = event.target.closest('.theme3d-case');
    if (!button || performance.now() < ignoreClickUntil || !privateViewUsable()) return;
    const target = entries.findIndex(entry => String(entry.game.id) === button.dataset.gameId);
    if (target === index) edit.click();
    else if (target >= 0) move(target, document.activeElement === button);
  });
  region.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || platformGroup.contains(event.target)) return;
    const targets = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: entries.length - 1 };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    move(targets[event.key], shelf.contains(event.target));
  });

  shelf.addEventListener('pointerdown', event => {
    if (event.isPrimary && event.pointerType !== 'mouse') {
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
  });
  shelf.addEventListener('pointerup', event => {
    if (gesture?.id !== event.pointerId) return;
    const distance = event.clientX - gesture.x;
    const height = Math.abs(event.clientY - gesture.y);
    gesture = undefined;
    if (Math.abs(distance) < 32 || Math.abs(distance) < height * 1.2) return;
    ignoreClickUntil = performance.now() + 350;
    move(index + (distance < 0 ? 1 : -1));
  });
  shelf.addEventListener('pointercancel', () => { gesture = undefined; });

  return {
    update(nextEntries, platform, platforms) {
      const selected = entries[index]?.game.id;
      const previousFocus = shelf.contains(document.activeElement);
      entries = nextEntries;
      index = Math.max(0, entries.findIndex(entry => entry.game.id === selected));
      currentPlatform = platform;
      updatePlatforms(platforms);
      draw();
      if (previousFocus && !shelf.contains(document.activeElement)) {
        slides.get(entries[index]).button.focus({ preventScroll: true });
      }
    },
    destroy() {
      entries = [];
      slides.clear();
      region.remove();
    }
  };
}
