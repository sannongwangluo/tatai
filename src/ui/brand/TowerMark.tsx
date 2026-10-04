import type { CSSProperties } from 'react';

export interface TowerMarkProps {
  className?: string;
  style?: CSSProperties;
  title?: string;
  'aria-label'?: string;
}

/** The approved tower outline, shared with favicon and native application icons. */
export function TowerMark({ className, style, title, 'aria-label': label }: TowerMarkProps) {
  const source = `url("${import.meta.env.BASE_URL}tatai-mark.svg")`;
  return (
    <span
      className={className}
      title={title}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        display: 'inline-block',
        width: 28,
        height: 32,
        flexShrink: 0,
        backgroundColor: 'currentColor',
        maskImage: source,
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: source,
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
        ...style,
      }}
    />
  );
}
