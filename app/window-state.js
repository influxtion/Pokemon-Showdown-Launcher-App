'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_BOUNDS = Object.freeze({ width: 1366, height: 768 });
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 640;
const MAX_SIZE = 20000;
const MAX_COORDINATE = 1000000;
const TITLEBAR_HEIGHT = 32;
const MIN_TITLEBAR_WIDTH = 120;

function isIntegerInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validBounds(bounds) {
  return !!bounds && typeof bounds === 'object' && !Array.isArray(bounds) &&
    isIntegerInRange(bounds.x, -MAX_COORDINATE, MAX_COORDINATE) &&
    isIntegerInRange(bounds.y, -MAX_COORDINATE, MAX_COORDINATE) &&
    isIntegerInRange(bounds.width, MIN_WIDTH, MAX_SIZE) &&
    isIntegerInRange(bounds.height, MIN_HEIGHT, MAX_SIZE);
}

function rect(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function reachableDisplays(bounds, displays) {
  return displays.flatMap((display, index) => {
    const area = rect(display && display.workArea);
    if (!area) return [];
    const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapHeight = Math.min(bounds.y + TITLEBAR_HEIGHT, area.y + area.height) - Math.max(bounds.y, area.y);
    if (overlapWidth < MIN_TITLEBAR_WIDTH || overlapHeight < Math.min(TITLEBAR_HEIGHT, area.height)) return [];
    return [{ display, area, index, overlap: overlapWidth * overlapHeight }];
  });
}

function chooseDisplay(displays) {
  if (!Array.isArray(displays)) return null;
  const valid = displays.flatMap((display, index) => {
    const area = rect(display && display.workArea);
    return area ? [{ display, area, index }] : [];
  });
  return valid.find(({ display }) => display.primary) || valid[0] || null;
}

function clampDimension(value, available, minimum) {
  return Math.max(minimum, Math.min(value, MAX_SIZE, Math.floor(available)));
}

function clampPosition(position, origin, available, size) {
  if (size > available) return Math.round(origin);
  return Math.round(Math.min(Math.max(position, origin), origin + available - size));
}

function defaultOptions(displays) {
  const chosen = chooseDisplay(displays);
  if (!chosen) return { ...DEFAULT_BOUNDS };
  return {
    width: clampDimension(DEFAULT_BOUNDS.width, chosen.area.width, MIN_WIDTH),
    height: clampDimension(DEFAULT_BOUNDS.height, chosen.area.height, MIN_HEIGHT),
  };
}

function parseState(text) {
  const state = JSON.parse(text);
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !validBounds(state.bounds) || typeof state.maximized !== 'boolean') return null;
  return { bounds: { ...state.bounds }, maximized: state.maximized };
}

class WindowState {
  constructor(userDataDir, fileSystem = fs) {
    this.file = path.join(userDataDir, 'window-state.json');
    this.fs = fileSystem;
  }

  load(displays = []) {
    if (!Array.isArray(displays)) displays = [];
    let saved;
    try {
      saved = parseState(this.fs.readFileSync(this.file, 'utf8'));
    } catch {
      saved = null;
    }
    if (!saved) {
      return defaultOptions(displays);
    }
    const reachable = reachableDisplays(saved.bounds, displays);
    if (!reachable.length) return defaultOptions(displays);
    reachable.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    const { area } = reachable[0];
    const width = clampDimension(saved.bounds.width, area.width, MIN_WIDTH);
    const height = clampDimension(saved.bounds.height, area.height, MIN_HEIGHT);
    return {
      x: clampPosition(saved.bounds.x, area.x, area.width, width),
      y: clampPosition(saved.bounds.y, area.y, area.height, height),
      width,
      height,
      maximized: saved.maximized,
    };
  }

  save(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        !validBounds(state.bounds) || typeof state.maximized !== 'boolean') return false;

    const temporaryFile = `${this.file}.tmp-${randomUUID()}`;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fs.writeFileSync(temporaryFile, JSON.stringify({
        bounds: {
          x: state.bounds.x,
          y: state.bounds.y,
          width: state.bounds.width,
          height: state.bounds.height,
        },
        maximized: state.maximized,
      }));
      this.fs.renameSync(temporaryFile, this.file);
      return true;
    } catch {
      try { this.fs.unlinkSync(temporaryFile); } catch {}
      return false;
    }
  }
}

module.exports = { WindowState, DEFAULT_BOUNDS };
