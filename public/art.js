// Meadow art: the sky, the hills, the plants and your little companion. All drawn as SVG.
(function () {
  const PLANTS = ['daisy', 'tulip', 'sunflower', 'mushroom', 'bluebell', 'fern', 'clover', 'poppy', 'lavender', 'berry'];

  // a stable pseudo-random number from a string, so a plant always sits in the same spot
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967295; }

  function skyFor(hour) {
    if (hour >= 5 && hour < 8) return { top: '#f7c6b4', mid: '#fbe3c8', low: '#fff3df', body: 'sun', bx: 70, by: 70, night: false };
    if (hour >= 8 && hour < 17) return { top: '#a9d4ef', mid: '#cfe7f3', low: '#f3f7ea', body: 'sun', bx: 300, by: 34, night: false };
    if (hour >= 17 && hour < 20) return { top: '#b49ad0', mid: '#f2b49a', low: '#fbe0bb', body: 'sun', bx: 290, by: 92, night: false };
    return { top: '#1d2348', mid: '#2e3767', low: '#4b4f7f', body: 'moon', bx: 300, by: 36, night: true };
  }

  function plant(type, x, y, s, delay) {
    const st = `style="animation-delay:${delay}s"`;
    const stem = (h, c = 'var(--stem)') => `<path d="M0 0 C -1 ${-h / 2} 1 ${-h / 2} 0 ${-h}" stroke="${c}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    const leaf = (side, yy) => `<path d="M0 ${yy} q ${side * 9} -4 ${side * 11} -11 q ${side * -8} 1 ${side * -11} 11z" fill="var(--leaf)"/>`;
    let g = '';
    switch (type) {
      case 'daisy': g = stem(24) + leaf(1, -8) + [0, 45, 90, 135, 180, 225, 270, 315].map(a => `<ellipse cx="0" cy="-30" rx="2.6" ry="6" fill="#fffdf6" transform="rotate(${a} 0 -24)"/>`).join('') + `<circle cy="-24" r="3.6" fill="#f4c64e"/>`; break;
      case 'tulip': g = stem(22) + leaf(-1, -6) + `<path d="M-7 -30 q 0 10 7 10 q 7 0 7 -10 l -3.5 4 l -3.5 -6 l -3.5 6z" fill="#ef8a8a"/>`; break;
      case 'sunflower': g = stem(30) + leaf(1, -10) + leaf(-1, -16) + [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(a => `<ellipse cx="0" cy="-38" rx="2.8" ry="6" fill="#f7c245" transform="rotate(${a} 0 -31)"/>`).join('') + `<circle cy="-31" r="5" fill="#8a5a33"/>`; break;
      case 'mushroom': g = `<rect x="-3" y="-12" width="6" height="12" rx="3" fill="#fbf1de"/><path d="M-11 -11 q 11 -16 22 0z" fill="#e46e5c"/><circle cx="-4" cy="-15" r="1.7" fill="#fff"/><circle cx="4" cy="-14" r="1.3" fill="#fff"/>`; break;
      case 'bluebell': g = `<path d="M0 0 C -1 -12 3 -20 8 -24" stroke="var(--stem)" stroke-width="2" fill="none" stroke-linecap="round"/>` + leaf(-1, -4) + `<path d="M4 -22 q 2 7 -1 9 q 4 1 6 -3 q 1 -5 -5 -6z" fill="#8fa3e8"/><path d="M8 -26 q 4 5 2 8 q 4 0 5 -4 q 0 -4 -7 -4z" fill="#a7b6ef"/>`; break;
      case 'fern': g = `<path d="M0 0 C 0 -10 2 -20 6 -28" stroke="var(--leaf)" stroke-width="2" fill="none"/>` + [-6, -11, -16, -21].map((yy, i) => `<ellipse cx="${-4 + i}" cy="${yy}" rx="5" ry="2" fill="var(--leaf)" transform="rotate(-25 ${-4 + i} ${yy})"/><ellipse cx="${5 + i}" cy="${yy - 2}" rx="5" ry="2" fill="var(--leaf)" transform="rotate(25 ${5 + i} ${yy - 2})"/>`).join(''); break;
      case 'clover': g = stem(12) + [[-4, -15], [4, -15], [0, -20]].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4.4" fill="#7fbf6a"/>`).join('') + `<circle cy="-16" r="1.4" fill="#5e9e4c"/>`; break;
      case 'poppy': g = stem(22) + leaf(1, -7) + `<circle cx="-3.5" cy="-24" r="5.5" fill="#f26b5b"/><circle cx="3.5" cy="-24" r="5.5" fill="#f47e6c"/><circle cy="-27" r="5" fill="#ee5f50"/><circle cy="-24" r="2" fill="#3a2a2a"/>`; break;
      case 'lavender': g = stem(26, '#8bab7a') + [0, 1, 2, 3, 4].map(i => `<ellipse cx="${i % 2 ? 1.6 : -1.6}" cy="${-14 - i * 3.6}" rx="2.4" ry="2.1" fill="#b59ae0"/>`).join(''); break;
      case 'berry': g = `<path d="M-6 0 q 0 -10 6 -14 q 6 4 6 14z" fill="var(--leaf)"/><circle cx="-3" cy="-9" r="2.4" fill="#d9475f"/><circle cx="3" cy="-6" r="2.4" fill="#e45a6f"/><circle cx="0" cy="-13" r="2.2" fill="#c93a53"/>`; break;
    }
    return `<g transform="translate(${x} ${y}) scale(${s})"><g class="sprout" ${st}>${g}</g></g>`;
  }

  // Your companion: a small round sprout friend. mood: happy | calm | sleepy | proud
  function buddy(mood) {
    const eyes = mood === 'sleepy'
      ? `<path d="M-9 -2 q 3 2 6 0 M3 -2 q 3 2 6 0" stroke="#3c3330" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
      : mood === 'happy' || mood === 'proud'
        ? `<path d="M-9 0 q 3 -4 6 0 M3 0 q 3 -4 6 0" stroke="#3c3330" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
        : `<circle cx="-6" cy="-1" r="2.2" fill="#3c3330"/><circle cx="6" cy="-1" r="2.2" fill="#3c3330"/><circle cx="-5.3" cy="-1.8" r=".7" fill="#fff"/><circle cx="6.7" cy="-1.8" r=".7" fill="#fff"/>`;
    const mouth = mood === 'sleepy' ? `<circle cy="6" r="1.4" fill="#3c3330"/>` : `<path d="M-3 5 q 3 3 6 0" stroke="#3c3330" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
    const extra = mood === 'proud' ? `<path d="M14 -24 l 1.5 3 3.2 .5 -2.3 2.2 .6 3.2 -3-1.5 -2.9 1.5 .6-3.2 -2.3-2.2 3.2-.5z" fill="#f7c948"/>` : mood === 'sleepy' ? `<text x="14" y="-18" font-size="9" fill="#fff" opacity=".85" font-family="ui-rounded,system-ui">z</text>` : '';
    return `<svg class="buddy ${mood}" viewBox="-26 -40 52 56" aria-hidden="true">
      <ellipse cy="13" rx="15" ry="3" fill="#000" opacity=".12"/>
      <g class="bob">
        <path d="M0 -20 C 0 -28 -2 -32 -5 -34" stroke="#6c9a52" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M-5 -34 q -10 -2 -12 6 q 9 1 12 -6z" fill="#86bf63"/>
        <path d="M-1 -30 q 9 -6 13 1 q -8 4 -13 -1z" fill="#9fd27a"/>
        <ellipse cy="-4" rx="17" ry="16" fill="var(--buddy)"/>
        <ellipse cx="-5" cy="-12" rx="6" ry="3.5" fill="#fff" opacity=".35"/>
        <ellipse cx="-11" cy="4" rx="3.6" ry="2.2" fill="#f39b9b" opacity=".6"/>
        <ellipse cx="11" cy="4" rx="3.6" ry="2.2" fill="#f39b9b" opacity=".6"/>
        ${eyes}${mouth}
        <ellipse cx="-7" cy="11" rx="4" ry="2.4" fill="var(--buddy-dark)"/><ellipse cx="7" cy="11" rx="4" ry="2.4" fill="var(--buddy-dark)"/>
        ${extra}
      </g></svg>`;
  }

  // The meadow scene. plants: [{ id, plant }] newest last.
  function meadow(plants, hour) {
    const sky = skyFor(hour);
    const W = 360, H = 170;
    let stars = '';
    if (sky.night) for (let i = 0; i < 26; i++) {
      const r = hash('star' + i), r2 = hash('s2' + i);
      stars += `<circle class="twinkle" style="animation-delay:${(r * 4).toFixed(2)}s" cx="${(r * W).toFixed(1)}" cy="${(r2 * 80).toFixed(1)}" r="${(0.6 + r2).toFixed(2)}" fill="#fff"/>`;
    }
    const body = sky.body === 'sun'
      ? `<circle cx="${sky.bx}" cy="${sky.by}" r="26" fill="#fff6d8" opacity=".45"/><circle cx="${sky.bx}" cy="${sky.by}" r="16" fill="#fff1b8"/>`
      : `<circle cx="${sky.bx}" cy="${sky.by}" r="14" fill="#fbf4d9"/><circle cx="${sky.bx + 6}" cy="${sky.by - 4}" r="12" fill="${sky.top}"/>`;
    const cloud = (x, y, s, o) => `<g class="drift" transform="translate(${x} ${y}) scale(${s})" opacity="${o}"><ellipse cx="0" cy="0" rx="22" ry="9" fill="#fff"/><ellipse cx="-10" cy="-5" rx="11" ry="9" fill="#fff"/><ellipse cx="8" cy="-7" rx="13" ry="11" fill="#fff"/></g>`;
    const clouds = sky.night ? '' : cloud(70, 40, 1, .8) + cloud(220, 26, .7, .65);
    const fireflies = sky.night ? [0, 1, 2, 3, 4, 5].map(i => `<circle class="firefly" style="animation-delay:${i * .7}s" cx="${40 + hash('f' + i) * 280}" cy="${100 + hash('g' + i) * 40}" r="1.8" fill="#f9f1a5"/>`).join('') : '';
    // cottage on the far hill
    const lit = sky.night || hour >= 17 || hour < 7;
    const cottage = `<g transform="translate(318 90)">
      <rect x="-12" y="-12" width="24" height="16" rx="2" fill="#f4e7d0"/><path d="M-16 -11 L0 -24 L16 -11z" fill="#b8644e"/>
      <rect x="-3" y="-6" width="6" height="10" rx="1" fill="#8b5a3c"/><rect x="5" y="-8" width="5" height="5" rx="1" fill="${lit ? '#ffd877' : '#bcd8e8'}"/>
      <rect x="6" y="-26" width="4" height="8" fill="#9a5544"/>
      ${lit ? '<circle cx="7.5" cy="-5.5" r="7" fill="#ffd877" opacity=".25"/>' : '<path class="smoke" d="M8 -28 q -4 -5 0 -9 q 4 -4 0 -8" stroke="#fff" stroke-width="2" fill="none" opacity=".6" stroke-linecap="round"/>'}
    </g>`;

    // place plants along the front hill, back rows smaller
    const shown = plants.slice(-28);
    let pl = '';
    shown.forEach((p, i) => {
      const r = hash(p.id), r2 = hash(p.id + 'y');
      const row = i % 3;                       // 0 back, 1 middle, 2 front
      const x = 18 + r * (W - 36);
      const y = 134 + row * 12 + r2 * 5;
      const s = 1 + row * 0.2;
      const isNew = i === shown.length - 1 && p.fresh;
      pl += plant(PLANTS.includes(p.plant) ? p.plant : 'daisy', x.toFixed(1), y.toFixed(1), s.toFixed(2), isNew ? 0 : (i * 0.04).toFixed(2));
    });
    // sort-of depth: draw back row first
    return `<svg class="meadow" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs><linearGradient id="skyg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky.top}"/><stop offset=".6" stop-color="${sky.mid}"/><stop offset="1" stop-color="${sky.low}"/></linearGradient>
      <filter id="soft"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .06 0"/><feComposite in2="SourceGraphic" operator="in"/><feBlend in="SourceGraphic" mode="multiply"/></filter></defs>
      <rect width="${W}" height="${H}" fill="url(#skyg)"/>
      ${stars}${body}${clouds}
      <path d="M0 108 C 70 78 150 84 210 98 S 320 84 360 92 V170 H0z" fill="var(--hill3)" ${sky.night ? 'opacity=".75"' : ''}/>
      ${cottage}
      <path d="M0 122 C 80 104 180 112 250 118 S 330 108 360 112 V170 H0z" fill="var(--hill2)" ${sky.night ? 'opacity=".85"' : ''}/>
      <path d="M0 136 C 90 124 200 128 280 134 S 340 128 360 130 V170 H0z" fill="var(--hill1)" filter="url(#soft)"/>
      ${pl}${fireflies}
    </svg>`;
  }

  window.ART = { meadow, buddy, plant, PLANTS, hash };
})();
