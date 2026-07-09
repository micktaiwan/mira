import { useState, type FormEvent } from 'react'

// This window's own profile is passed statically on the renderer URL. Switching
// profiles lives in the native app menu, not here.
const OWN_PROFILE = new URLSearchParams(window.location.search).get('profile') ?? 'default'

function App(): React.JSX.Element {
  const [url, setUrl] = useState('')

  const onSubmitUrl = (e: FormEvent): void => {
    e.preventDefault()
    // The chrome never navigates directly: it asks the command registry to.
    window.mira.command('navigate', { url })
  }

  return (
    <div className="toolbar">
      <span className="profile-badge" title="This window's profile">
        {OWN_PROFILE}
      </span>
      <form className="address-form" onSubmit={onSubmitUrl}>
        <input
          className="address-input"
          type="text"
          placeholder="Search or enter address"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </form>
    </div>
  )
}

export default App
