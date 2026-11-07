import '@kgdiff/viewer';
import type { GraphSource, KgdiffViewerElement } from '@kgdiff/viewer';
import type {} from '@kgdiff/viewer/react';
import { useEffect, useRef } from 'react';

interface Props {
  readonly before: GraphSource;
  readonly after: GraphSource;
  readonly onSelect: (hunk: string | null) => void;
}

export function GraphDiff({ before, after, onSelect }: Props) {
  const viewer = useRef<KgdiffViewerElement>(null);

  useEffect(() => {
    void viewer.current?.load({ before, after });
  }, [before, after]);

  return (
    <kgdiff-viewer
      ref={viewer}
      theme="auto"
      panels={{ detail: 'collapsed' }}
      keymap={{ x: null, r: 'review' }}
      onkgdiff-select={(event) => onSelect(event.detail.hunk)}
      style={{ height: 640 }}
    />
  );
}
