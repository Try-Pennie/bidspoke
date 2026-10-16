'use client'

/**
 * The Toggle, part of the design system controls in form.tsx, in a file of
 * its own so a route with no switch does not load @radix-ui/react-switch.
 */
import * as RadixSwitch from '@radix-ui/react-switch'

/**
 * An on or off setting, on @radix-ui/react-switch. In a form it submits under
 * `name` as a checkbox does ("on" when on, nothing when off).
 */
export function Toggle({ id, checked, onChange, label, disabled, name }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; name?: string }) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      name={name}
      className={`toggle ${checked ? 'toggle-on' : ''}`.trim()}
    >
      <RadixSwitch.Thumb className="toggle-knob" />
    </RadixSwitch.Root>
  )
}
