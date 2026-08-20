import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// 证据图片上的框选。对应用户旅程第四步与界面文档 5.1 节：
// 在原图上圈一下，再说一句话，就能改。
//
// 坐标按图片宽高归一化后上送，与图片实际像素无关：换一张分辨率不同的原件
// 不影响已经留痕的位置。同一份资料的高低分辨率两个版本像素坐标完全不同，
// 按像素留痕会在换件后指到别处。

export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EvidenceMarqueeProps {
  readonly src: string;
  readonly alt: string;
  readonly selection: NormalizedRect | null;
  readonly onSelect: (rect: NormalizedRect | null) => void;
}

// 小于这个比例的拖动当作点击，不产生选区：误触不该留下一个看不见的框
const MINIMUM_FRACTION = 0.01;

function normalize(start: { x: number; y: number }, end: { x: number; y: number }): NormalizedRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.min(1 - x, Math.abs(end.x - start.x)),
    height: Math.min(1 - y, Math.abs(end.y - start.y)),
  };
}

export function EvidenceMarquee({ src, alt, selection, onSelect }: EvidenceMarqueeProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<NormalizedRect | null>(null);

  const pointFor = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current;
    if (!frame) return null;
    const box = frame.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    };
  }, []);

  const handleDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointFor(event);
    if (!point) return;
    startRef.current = point;
    setDragging({ x: point.x, y: point.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pointFor]);

  const handleMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    const point = start ? pointFor(event) : null;
    if (!start || !point) return;
    setDragging(normalize(start, point));
  }, [pointFor]);

  const handleUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    const point = start ? pointFor(event) : null;
    startRef.current = null;
    setDragging(null);
    if (!start || !point) return;
    const rect = normalize(start, point);
    onSelect(rect.width < MINIMUM_FRACTION || rect.height < MINIMUM_FRACTION ? null : rect);
  }, [onSelect, pointFor]);

  const shown = dragging ?? selection;

  return (
    <div
      className="evidence-marquee"
      ref={frameRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
    >
      <img src={src} alt={alt} draggable={false} />
      {shown && (
        <div
          className="evidence-marquee__rect"
          style={{
            left: `${shown.x * 100}%`,
            top: `${shown.y * 100}%`,
            width: `${shown.width * 100}%`,
            height: `${shown.height * 100}%`,
          }}
        />
      )}
    </div>
  );
}
