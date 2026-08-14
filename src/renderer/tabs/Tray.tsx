import { useState } from 'react'
import { filesFrom, trayPathsFor } from '../pasteImages'
import { usePlatform } from '../platform'

interface Props {
  attachments: string[]
  onAdd: (paths: string[]) => void
  onRemove: (path: string) => void
  onClear: () => void
}

export function Tray({ attachments, onAdd, onRemove, onClear }: Props): React.JSX.Element {
  const [hovering, setHovering] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const platform = usePlatform()

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setHovering(false)
    // Same resolver as a paste, because a drag can carry either kind of payload:
    // a file from the file manager has a path, an image dragged out of a browser
    // is only bytes and has to be written down before the tray can hold it.
    const files = filesFrom(event.dataTransfer)
    void trayPathsFor(files).then((paths) => {
      if (paths.length) onAdd(paths)
    })
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
          They become @-references on your next dispatch. Nothing is uploaded, and
          dropped files stay where they are.
        </div>
        {platform && (
          <div className="muted small">
            {platform.os === 'darwin' ? '⌘V' : 'Ctrl+V'} pastes a screenshot in from
            anywhere in the panel.
          </div>
        )}
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
  const trimmed = path.replace(/[\\/]+$/, '')
  const boundary = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (boundary < 0) return ''
  if (boundary === 0) return trimmed[0]
  if (boundary === 2 && /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.slice(0, 3)
  return trimmed.slice(0, boundary)
}

function extension(name: string): string {
  const value = name.includes('.') ? name.split('.').pop() ?? 'FILE' : 'FILE'
  return value.slice(0, 4).toUpperCase()
}
