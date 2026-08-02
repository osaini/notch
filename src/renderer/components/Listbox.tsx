import { useEffect, useId, useRef, useState } from 'react'

export interface ListboxOption {
  value: string
  title: string
  meta?: string
  aside?: string
  kind?: 'project' | 'display'
}

interface Props {
  label: string
  value: string
  options: ListboxOption[]
  placeholder: string
  onChange: (value: string) => void
  onBrowse?: () => void
  browsing?: boolean
}

export function Listbox({
  label,
  value,
  options,
  placeholder,
  onChange,
  onBrowse,
  browsing = false
}: Props): React.JSX.Element {
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  const close = (returnFocus = true): void => {
    setOpen(false)
    if (returnFocus) window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  const choose = (index: number): void => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    close()
  }

  const move = (key: string, index: number): void => {
    if (!options.length) return
    if (key === 'ArrowDown') setActiveIndex(Math.min(options.length - 1, index + 1))
    if (key === 'ArrowUp') setActiveIndex(Math.max(0, index - 1))
    if (key === 'Home') setActiveIndex(0)
    if (key === 'End') setActiveIndex(options.length - 1)
  }

  return (
    <div ref={rootRef} className={`listbox ${open ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        type="button"
        className="listbox-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-expanded={open}
        onClick={() => {
          setActiveIndex(selectedIndex)
          setOpen((current) => !current)
        }}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            setOpen(true)
            if (event.key === 'ArrowDown') setActiveIndex(Math.min(options.length - 1, selectedIndex + 1))
            else if (event.key === 'ArrowUp') setActiveIndex(Math.max(0, selectedIndex - 1))
            else setActiveIndex(event.key === 'Home' ? 0 : options.length - 1)
          }
          if (event.key === 'Escape') close(false)
        }}
      >
        <OptionContent option={selected} placeholder={placeholder} />
        <i className="chevron" aria-hidden="true" />
      </button>

      {open && (
        <div id={`${id}-list`} className="listbox-options" role="listbox" aria-labelledby={`${id}-trigger`}>
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              className={index === activeIndex ? 'listbox-option active' : 'listbox-option'}
              role="option"
              aria-selected={option.value === value}
              tabIndex={index === activeIndex ? 0 : -1}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              onKeyDown={(event) => {
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  move(event.key, index)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  choose(index)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  close()
                }
              }}
            >
              <OptionContent option={option} placeholder={placeholder} />
            </button>
          ))}
          {onBrowse && (
            <button
              type="button"
              className="listbox-browse"
              onClick={() => {
                close(false)
                onBrowse()
              }}
            >
              <span>+</span>{browsing ? 'Opening…' : 'Browse for a folder…'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function OptionContent({
  option,
  placeholder
}: {
  option?: ListboxOption
  placeholder: string
}): React.JSX.Element {
  return (
    <span className="listbox-content">
      <i className={option?.kind === 'display' ? 'display-mark' : 'project-dot'} aria-hidden="true" />
      <span className="listbox-copy">
        <strong>{option?.title ?? placeholder}</strong>
        {option?.meta && <small>{option.meta}</small>}
      </span>
      {option?.aside && <em>{option.aside}</em>}
    </span>
  )
}
