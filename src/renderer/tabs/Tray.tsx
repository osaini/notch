import { useState } from 'react'

interface Props {
  attachments: string[]
  onAdd: (paths: string[]) => void
  onRemove: (path: string) => void
  onClear: () => void
}

export function Tray({ attachments, onAdd, onRemove, onClear }: Props): React.JSX.Element {
  const [hovering, setHovering] = useState(false)
  const [selecting, setSelecting] = useState(false)

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setHovering(false)
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = window.notch.pathForFile(file)
      if (path) paths.push(path)
    }
    if (paths.length) onAdd(paths)
  }

  const chooseFiles = async (): Promise<void> => {
    if (selecting) return
    setSelecting(true)
    try {
      const paths = await window.notch.browseFiles()
      if (paths.length) onAdd(paths)
    } finally {
      setSelecting(false)
    }
  }

  return (
    <div className="tab-pane tray-pane">
      <div
        className={`dropzone ${hovering ? 'hover' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Add files to the tray"
        aria-busy={selecting}
        onClick={() => void chooseFiles()}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          void chooseFiles()
        }}
        onDragOver={(event) => { event.preventDefault(); setHovering(true) }}
        onDragLeave={() => setHovering(false)}
        onDrop={handleDrop}
      >
        <span className="dropzone-plus">+</span>
        <div className="dropzone-title">
          {selecting ? 'Choosing files…' : 'Drop files here or click to choose'}
        </div>
        <div className="muted small">
          They become @-references on your next dispatch. Nothing is copied or uploaded.
        </div>
      </div>

      <div className="section-rule">
        <span>Held</span><i /><em>{String(attachments.length).padStart(2, '0')}</em>
      </div>

      {attachments.length > 0 ? (
        <>
          <ul className="attachment-list">
            {attachments.map((path) => {
              const name = leaf(path)
              return (
                <li key={path} className="attachment-row" title={path}>
                  <span className="file-ext">{extension(name)}</span>
                  <span className="attachment-copy"><strong>{name}</strong><small>{parent(path)}</small></span>
                  <button type="button" className="reveal-file" onClick={() => window.notch.revealPath(path)}>Reveal</button>
                  <button type="button" className="remove-file" aria-label={`Remove ${name}`} onClick={() => onRemove(path)}>×</button>
                </li>
              )
            })}
          </ul>
          <button type="button" className="btn clear-tray" onClick={onClear}>Clear tray</button>
        </>
      ) : <p className="footnote">Nothing in the tray yet.</p>}
    </div>
  )
}

function leaf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

function parent(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.slice(0, -1).join('\\')
}

function extension(name: string): string {
  const value = name.includes('.') ? name.split('.').pop() ?? 'FILE' : 'FILE'
  return value.slice(0, 4).toUpperCase()
}
