import { useRef, useEffect } from 'react';
import type { PnlPoint } from '../types';

interface Props {
  points: PnlPoint[];
}

export function PnlChart({ points }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 20, right: 16, bottom: 24, left: 56 };

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Filter out points with missing PnL values
    const validPoints = points.filter(p => typeof p.cumulative_pnl === 'number' && Number.isFinite(p.cumulative_pnl));

    if (validPoints.length < 2) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Awaiting trade data...', w / 2, h / 2);
      return;
    }

    const values = validPoints.map(p => p.cumulative_pnl);
    const minVal = Math.min(0, ...values);
    const maxVal = Math.max(0, ...values);
    const range = maxVal - minVal || 1;

    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const toX = (i: number) => pad.left + (i / (points.length - 1)) * plotW;
    const toY = (v: number) => pad.top + plotH - ((v - minVal) / range) * plotH;

    // Zero line
    const zeroY = toY(0);
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(w - pad.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Y-axis labels
    ctx.fillStyle = '#9ca3af';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('$0', pad.left - 6, zeroY + 4);
    ctx.fillText(`$${maxVal.toFixed(0)}`, pad.left - 6, pad.top + 12);
    if (minVal < 0) {
      ctx.fillText(`$${minVal.toFixed(0)}`, pad.left - 6, h - pad.bottom);
    }

    // Draw PnL area + line
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]!));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(toX(i), toY(values[i]!));
    }

    // Stroke the line
    const lastVal = values[values.length - 1]!;
    ctx.strokeStyle = lastVal >= 0 ? '#22c55e' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill area to zero
    ctx.lineTo(toX(values.length - 1), zeroY);
    ctx.lineTo(toX(0), zeroY);
    ctx.closePath();
    ctx.fillStyle = lastVal >= 0 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    ctx.fill();

    // End dot
    const lastX = toX(values.length - 1);
    const lastY = toY(lastVal);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = lastVal >= 0 ? '#22c55e' : '#ef4444';
    ctx.fill();

    // Current PnL label
    ctx.fillStyle = lastVal >= 0 ? '#22c55e' : '#ef4444';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`$${lastVal.toFixed(2)}`, lastX + 8, lastY + 4);

  }, [points]);

  return (
    <div className="panel">
      <h3 className="panel-title">Intraday P&L</h3>
      <div className="chart-container">
        <canvas ref={canvasRef} className="pnl-canvas" />
      </div>
    </div>
  );
}
