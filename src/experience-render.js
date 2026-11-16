import { GlobeRenderer } from './globe.js';
import { INK } from './palette.js';

/** A physical-value scale sampled from the exact published ramp used to decode a frame. */
export function sampledScale(palette, units) {
  const colors = palette.colors;
  const values = palette.positions;
  if (!colors?.length || values?.length !== colors.length) {
    throw new Error('Incomplete published color scale');
  }
  return {
    kind: 'sequential', lo: palette.lo, hi: palette.hi, units,
    colourAt(value) {
      let low = 0;
      let high = values.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (values[middle] < value) low = middle + 1;
        else high = middle;
      }
      const hex = colors[low];
      return `rgb(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)})`;
    },
    ticks: () => palette.kind === 'log'
      ? [palette.hi, 1, .1, .01, palette.lo].filter((value, index, ticks) =>
        value >= palette.lo && value <= palette.hi && ticks.indexOf(value) === index,
      )
      : [palette.hi, (palette.lo + palette.hi) / 2, palette.lo],
  };
}

/** The stage reads the same decoded cells and current row as the audio session. */
export class ExperienceRenderer {
  constructor(canvas, series, scale) {
    this.canvas = canvas;
    this.series = series;
    this.scale = scale;
    if (series.grid.kind === 'geo') {
      this.globe = new GlobeRenderer(canvas, series);
      this.globe.setScale(scale);
    } else {
      this.raster = document.createElement('canvas');
      this.raster.width = series.grid.nlon;
      this.raster.height = series.grid.nlat;
      const context = this.raster.getContext('2d');
      for (let row = 0; row < series.grid.nlat; row++) {
        for (let column = 0; column < series.grid.nlon; column++) {
          const cell = series.cellAt(0, row, column);
          context.fillStyle = cell.observed ? scale.colourAt(cell.value) : INK.surface;
          context.fillRect(column, series.grid.nlat - 1 - row, 1, 1);
        }
      }
      this.resize();
    }
  }

  resize() {
    if (this.globe) {
      this.globe.resize();
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    const density = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(bounds.width * density));
    this.canvas.height = Math.max(1, Math.round(bounds.height * density));
  }

  draw(index, region) {
    if (this.globe) {
      this.globe.draw(index, region);
      return;
    }
    const context = this.canvas.getContext('2d');
    const width = this.canvas.width;
    const height = this.canvas.height;
    context.fillStyle = INK.plane;
    context.fillRect(0, 0, width, height);
    const mapHeight = Math.min(height * .82, width / 2);
    const mapTop = (height - mapHeight) / 2;
    context.imageSmoothingEnabled = false;
    context.drawImage(this.raster, 0, mapTop, width, mapHeight);
    const scanTop = index / (this.series.count - 1) * mapHeight + mapTop;
    context.strokeStyle = INK.primary;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, scanTop);
    context.lineTo(width, scanTop);
    context.stroke();
  }
}
