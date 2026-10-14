// Controls: sliders built on native range inputs (so touch and keyboard work as expected)
// and colour wheels, grouped into sections that become tabs on phones.

const SNAP = 4; // slider drag distance from the centre that snaps back to 0
const WHEEL_SNAP = 0.08; // same idea for a wheel, as a fraction of its radius
const WHEEL_STEP = 0.02; // arrow-key nudge
const DOT_RADIUS = 7; // half of .wheel-dot's size in style.css

// Plays the click wave on any button: on press for mouse and touch, on activation for keyboard.
export function enableButtonWave() {
  function wave(button) {
    button.classList.remove('is-waving');
    void button.offsetWidth; // restart the animation on rapid clicks
    button.classList.add('is-waving');
  }

  document.addEventListener('pointerdown', (e) => {
    const button = e.target.closest('button');
    if (button) wave(button);
  });
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button && e.detail === 0) wave(button);
  });
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'wave') e.target.classList.remove('is-waving');
  });
}

// defs are sliders ({ key, label, group, min, max }) or wheels ({ type: 'wheel', key, label, group }).
// A wheel reports two values, key + 'x' and key + 'y', each -1..1.
export function buildSliders(container, defs, onChange) {
  const inputs = {};
  const wheels = {};
  const groups = [];
  let groupEl = null;

  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  container.append(tabs);

  function selectGroup(name) {
    for (const group of groups) {
      const active = group.name === name;
      group.el.classList.toggle('is-active', active);
      group.tab.classList.toggle('is-active', active);
      group.tab.setAttribute('aria-pressed', active);
    }
  }

  function paint(input, output) {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const pos = (value - min) / (max - min);
    const zero = (0 - min) / (max - min);
    input.style.setProperty('--a', Math.min(pos, zero));
    input.style.setProperty('--b', Math.max(pos, zero));
    output.textContent = value > 0 && min < 0 ? '+' + value : String(value);
    output.classList.toggle('is-set', value !== 0);
  }

  // Keeps the dot inside the wheel and rounds to two decimals.
  function moveWheel(wheel, x, y) {
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    wheel.x = Math.round(x * 100) / 100;
    wheel.y = Math.round(y * 100) / 100;
    wheel.el.style.setProperty('--x', wheel.x);
    wheel.el.style.setProperty('--y', wheel.y);
    wheel.el.classList.toggle('is-set', wheel.x !== 0 || wheel.y !== 0);
  }

  function values() {
    const out = {};
    for (const key in inputs) out[key] = Number(inputs[key].input.value) / 100;
    for (const key in wheels) {
      out[key + 'x'] = wheels[key].x;
      out[key + 'y'] = wheels[key].y;
    }
    return out;
  }

  function addSlider(def, i) {
    const row = document.createElement('label');
    row.className = 'slider';
    row.style.setProperty('--i', i);

    const head = document.createElement('span');
    head.className = 'slider-head';
    const name = document.createElement('span');
    name.className = 'slider-name';
    name.textContent = def.label;
    const output = document.createElement('output');
    head.append(name, output);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = def.min;
    input.max = def.max;
    input.step = 1;
    input.value = 0;
    if (def.min >= 0) input.classList.add('from-start');

    // Snap to the centre only while dragging, so arrow keys can still step off 0.
    let dragging = false;
    input.addEventListener('pointerdown', () => { dragging = true; });
    input.addEventListener('pointerup', () => { dragging = false; });
    input.addEventListener('pointercancel', () => { dragging = false; });
    input.addEventListener('input', () => {
      if (dragging && def.min < 0 && Math.abs(Number(input.value)) <= SNAP) input.value = 0;
      paint(input, output);
      onChange(values());
    });
    input.addEventListener('dblclick', () => {
      input.value = 0;
      paint(input, output);
      onChange(values());
    });

    row.append(head, input);
    groupEl.append(row);
    inputs[def.key] = { input, output };
    paint(input, output);
  }

  function addWheel(def, i) {
    // Neighbouring wheels share one row.
    let row = groupEl.lastElementChild;
    if (!row.classList.contains('wheels')) {
      row = document.createElement('div');
      row.className = 'wheels';
      groupEl.append(row);
    }

    const cell = document.createElement('div');
    cell.className = 'wheel-cell';
    cell.style.setProperty('--i', i);
    const el = document.createElement('div');
    el.className = 'wheel';
    el.tabIndex = 0;
    el.setAttribute('aria-label', def.label + ' tint');
    const dot = document.createElement('span');
    dot.className = 'wheel-dot';
    el.append(dot);
    const name = document.createElement('span');
    name.className = 'wheel-name';
    name.textContent = def.label;
    cell.append(el, name);
    row.append(cell);

    const wheel = { el, x: 0, y: 0 };
    wheels[def.key] = wheel;

    function update(x, y) {
      moveWheel(wheel, x, y);
      onChange(values());
    }

    // Pointer position relative to the centre, as a fraction of the dot's travel. Up is positive.
    function fromPointer(e) {
      const box = el.getBoundingClientRect();
      const radius = box.width / 2 - DOT_RADIUS;
      let x = (e.clientX - (box.left + box.width / 2)) / radius;
      let y = -(e.clientY - (box.top + box.height / 2)) / radius;
      if (Math.hypot(x, y) < WHEEL_SNAP) {
        x = 0;
        y = 0;
      }
      update(x, y);
    }

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      fromPointer(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) fromPointer(e);
    });
    el.addEventListener('dblclick', () => update(0, 0));
    el.addEventListener('keydown', (e) => {
      const step = {
        ArrowLeft: [-WHEEL_STEP, 0], ArrowRight: [WHEEL_STEP, 0],
        ArrowUp: [0, WHEEL_STEP], ArrowDown: [0, -WHEEL_STEP],
      }[e.key];
      if (!step) return;
      e.preventDefault();
      update(wheel.x + step[0], wheel.y + step[1]);
    });
  }

  defs.forEach((def, i) => {
    if (!groups.length || groups[groups.length - 1].name !== def.group) {
      groupEl = document.createElement('section');
      groupEl.className = 'group';
      const title = document.createElement('h2');
      title.className = 'group-title';
      title.textContent = def.group;
      groupEl.append(title);
      container.append(groupEl);

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.textContent = def.group;
      tab.addEventListener('click', () => selectGroup(def.group));
      tabs.append(tab);
      groups.push({ name: def.group, el: groupEl, tab });
    }

    if (def.type === 'wheel') addWheel(def, i);
    else addSlider(def, i);
  });

  selectGroup(groups[0].name);

  return {
    values,
    // Moves every control to the given values (same scale that values() returns).
    set(next) {
      for (const key in inputs) {
        inputs[key].input.value = Math.round((next[key] || 0) * 100);
        paint(inputs[key].input, inputs[key].output);
      }
      for (const key in wheels) {
        moveWheel(wheels[key], next[key + 'x'] || 0, next[key + 'y'] || 0);
      }
      onChange(values());
    },
  };
}
