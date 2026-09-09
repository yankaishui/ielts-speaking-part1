/* Aggregate product events only: no answers, recordings, user IDs or cookies. */
(() => {
  const hosts = new Set(['part1.yankaishui.com', 'part2.yankaishui.com', 'ielts-speaking-part1.pages.dev', 'ielts-speaking-timer.pages.dev']);
  const allowed = new Set(['page_open', 'practice_start', 'practice_end', 'practice_complete', 'specialty_open', 'answer_prep_start', 'answer_prep_end']);
  window.trackPractice = (event, mode = 'default') => {
    if (!hosts.has(location.hostname) || !allowed.has(event) || navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    try {
      void fetch('https://part2.yankaishui.com/api/practice-events', {
        method: 'POST', credentials: 'omit', keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ event, mode })
      }).catch(() => {});
    } catch { /* Analytics must never block practice. */ }
  };
  window.trackPractice('page_open');
})();
