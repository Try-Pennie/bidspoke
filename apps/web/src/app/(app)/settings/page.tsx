import { redirect } from 'next/navigation'

export const runtime = 'edge'

export default function SettingsIndex() {
  redirect('/settings/access')
}
