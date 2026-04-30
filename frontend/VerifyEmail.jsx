/**
 * VerifyEmail.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * CropAI — Email Verification Page
 *
 * Features:
 *  • Reads :token from the URL via react-router-dom useParams
 *  • Calls GET http://localhost:5000/verify/<token> on mount
 *  • Shows a loading spinner → success card or error card
 *  • Auto-redirects to /login after 3 s on success
 *  • Fade-in animation on every state change
 *  • Fully responsive (mobile-first Tailwind classes)
 *  • Matches the CropAI "Futuristic Jungle" dark-mode palette
 * ─────────────────────────────────────────────────────────────────────────────
 * Dependencies:
 *   npm install react-router-dom
 *   Tailwind CSS must be configured in the project
 * ─────────────────────────────────────────────────────────────────────────────
 * Route setup (App.jsx or equivalent):
 *   import VerifyEmail from './VerifyEmail';
 *   <Route path="/verify/:token" element={<VerifyEmail />} />
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Base URL for the backend API */
const API_BASE = 'http://localhost:3000';

/** Seconds before auto-redirecting to /login on success */
const AUTO_REDIRECT_DELAY = 3;

// ─── Inline keyframe style (injected once) ───────────────────────────────────
// We inject a tiny <style> tag so Tailwind's purge doesn't strip custom
// keyframes that aren't used elsewhere in the project.
const ANIMATION_STYLE = `
  @keyframes cropai-fadeIn {
    from { opacity: 0; transform: translateY(24px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)   scale(1);    }
  }
  @keyframes cropai-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes cropai-blob {
    0%,100% { transform: translate(0,0)   scale(1);   }
    33%      { transform: translate(80px,160px) scale(1.15); }
    66%      { transform: translate(-100px,80px) scale(0.85); }
  }
  @keyframes cropai-pulse-ring {
    0%   { box-shadow: 0 0 0 0   rgba(0,255,136,0.45); }
    70%  { box-shadow: 0 0 0 18px rgba(0,255,136,0);    }
    100% { box-shadow: 0 0 0 0   rgba(0,255,136,0);     }
  }
  @keyframes cropai-countdown {
    from { stroke-dashoffset: 0; }
    to   { stroke-dashoffset: 88; }  /* circumference ≈ 88 */
  }
  .cropai-fade-in {
    animation: cropai-fadeIn 0.65s cubic-bezier(0.16,1,0.3,1) both;
  }
  .cropai-spinner {
    animation: cropai-spin 0.9s linear infinite;
  }
  .cropai-blob {
    animation: cropai-blob 22s ease-in-out infinite alternate;
    border-radius: 50%;
    position: absolute;
    pointer-events: none;
    will-change: transform;
  }
  .cropai-pulse { animation: cropai-pulse-ring 1.8s ease-out infinite; }
  .cropai-countdown-ring {
    animation: cropai-countdown ${AUTO_REDIRECT_DELAY}s linear forwards;
  }
`;

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Animated background blobs — mirrors the effect on login.html
 */
const BackgroundBlobs = () => (
  <div
    aria-hidden="true"
    className="fixed inset-0 overflow-hidden pointer-events-none -z-10"
    style={{ opacity: 0.45 }}
  >
    <div
      className="cropai-blob"
      style={{
        width: 480,
        height: 480,
        background: 'rgba(0,255,136,0.13)',
        top: -120,
        left: -120,
        animationDuration: '25s',
      }}
    />
    <div
      className="cropai-blob"
      style={{
        width: 420,
        height: 420,
        background: 'rgba(188,19,254,0.09)',
        bottom: -150,
        right: -100,
        animationDuration: '31s',
        animationDelay: '-8s',
      }}
    />
    <div
      className="cropai-blob"
      style={{
        width: 320,
        height: 320,
        background: 'rgba(0,229,255,0.07)',
        top: '45%',
        left: '60%',
        animationDuration: '19s',
        animationDelay: '-4s',
      }}
    />
  </div>
);

// ─── Icon components (pure SVG, no external dependency) ──────────────────────

/** Animated check-mark in a glowing circle */
const SuccessIcon = () => (
  <div
    className="cropai-pulse mx-auto mb-6 flex items-center justify-center rounded-full"
    style={{
      width: 88,
      height: 88,
      background: 'linear-gradient(135deg, rgba(0,255,136,0.15), rgba(0,255,136,0.05))',
      border: '2px solid rgba(0,255,136,0.5)',
    }}
  >
    <svg
      viewBox="0 0 52 52"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 44, height: 44 }}
      aria-hidden="true"
    >
      <circle
        cx="26"
        cy="26"
        r="25"
        fill="none"
        stroke="rgba(0,255,136,0.25)"
        strokeWidth="1.5"
      />
      <polyline
        points="14,26 22,34 38,18"
        fill="none"
        stroke="#00ff88"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </div>
);

/** Error icon */
const ErrorIcon = () => (
  <div
    className="mx-auto mb-6 flex items-center justify-center rounded-full"
    style={{
      width: 88,
      height: 88,
      background: 'linear-gradient(135deg, rgba(255,80,80,0.15), rgba(255,80,80,0.05))',
      border: '2px solid rgba(255,80,80,0.45)',
      boxShadow: '0 0 24px rgba(255,80,80,0.2)',
    }}
  >
    <svg
      viewBox="0 0 52 52"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 44, height: 44 }}
      aria-hidden="true"
    >
      <circle
        cx="26"
        cy="26"
        r="25"
        fill="none"
        stroke="rgba(255,80,80,0.25)"
        strokeWidth="1.5"
      />
      <line
        x1="16" y1="16" x2="36" y2="36"
        stroke="#ff5050"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="36" y1="16" x2="16" y2="36"
        stroke="#ff5050"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  </div>
);

/** Spinner ring */
const SpinnerIcon = () => (
  <div className="mx-auto mb-6" style={{ width: 88, height: 88 }}>
    <svg
      className="cropai-spinner"
      viewBox="0 0 52 52"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 88, height: 88 }}
      aria-label="Loading"
    >
      <circle
        cx="26" cy="26" r="22"
        fill="none"
        stroke="rgba(0,255,136,0.15)"
        strokeWidth="3"
      />
      <path
        d="M26 4 a22 22 0 0 1 22 22"
        fill="none"
        stroke="#00ff88"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  </div>
);

/**
 * Countdown ring that visually counts down AUTO_REDIRECT_DELAY seconds.
 * Uses SVG stroke-dashoffset animation defined in ANIMATION_STYLE.
 */
const CountdownRing = ({ seconds }) => {
  const radius = 14;
  const circ = Math.round(2 * Math.PI * radius); // ≈ 88

  return (
    <div className="inline-flex items-center gap-2 mt-4">
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
        {/* background track */}
        <circle
          cx="18" cy="18" r={radius}
          fill="none"
          stroke="rgba(0,255,136,0.15)"
          strokeWidth="2.5"
        />
        {/* animated stroke */}
        <circle
          cx="18" cy="18" r={radius}
          fill="none"
          stroke="#00ff88"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset="0"
          transform="rotate(-90 18 18)"
          className="cropai-countdown-ring"
          style={{ animationDuration: `${AUTO_REDIRECT_DELAY}s` }}
        />
        {/* countdown number */}
        <text
          x="18" y="22"
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill="#00ff88"
          fontFamily="Outfit, sans-serif"
        >
          {seconds}
        </text>
      </svg>
      <span style={{ color: '#8aa395', fontSize: '0.875rem' }}>
        Redirecting to login…
      </span>
    </div>
  );
};

// ─── CropAI logo wordmark ─────────────────────────────────────────────────────
const Logo = () => (
  <div className="mb-8 flex flex-col items-center gap-2">
    {/* Leaf SVG icon */}
    <svg
      width="48" height="48"
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="CropAI logo"
    >
      <circle cx="24" cy="24" r="24" fill="rgba(0,255,136,0.08)" />
      <path
        d="M24 10 C14 10 10 20 10 28 C10 36 16 40 24 40 C32 40 38 36 38 24 C38 14 28 10 24 10Z"
        fill="rgba(0,255,136,0.18)"
        stroke="#00ff88"
        strokeWidth="1.5"
      />
      <path
        d="M24 38 C24 38 24 24 36 16"
        stroke="#00ff88"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>

    {/* Wordmark */}
    <span
      style={{
        fontFamily: "'Outfit', sans-serif",
        fontWeight: 800,
        fontSize: '1.5rem',
        letterSpacing: '-0.5px',
        background: 'linear-gradient(135deg, #ffffff 0%, #00ff88 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      }}
    >
      CropAI
    </span>
  </div>
);

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * VerifyEmail
 *
 * Reads the verification token from the URL (/verify/:token),
 * calls the backend, and displays the appropriate UI state.
 */
const VerifyEmail = () => {
  // react-router hooks
  const { token } = useParams();
  const navigate = useNavigate();

  // UI state: 'loading' | 'success' | 'error'
  const [status, setStatus] = useState('loading');

  // Human-readable message from the backend (optional)
  const [message, setMessage] = useState('');

  // Countdown seconds remaining before auto-redirect
  const [countdown, setCountdown] = useState(AUTO_REDIRECT_DELAY);

  // ── Inject animation styles once ──────────────────────────────────────────
  useEffect(() => {
    if (document.getElementById('cropai-verify-style')) return;
    const style = document.createElement('style');
    style.id = 'cropai-verify-style';
    style.textContent = ANIMATION_STYLE;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // ── Verify token on mount ──────────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token found in the URL.');
      return;
    }

    let cancelled = false;

    const verify = async () => {
      try {
        const response = await fetch(`${API_BASE}/verify/${encodeURIComponent(token)}`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        if (cancelled) return;

        if (response.ok) {
          // Try to extract a success message from the JSON body
          try {
            const data = await response.json();
            setMessage(data.message || 'Your account is now active.');
          } catch {
            setMessage('Your account is now active.');
          }
          setStatus('success');
        } else {
          // Try extracting an error message from the JSON body
          try {
            const data = await response.json();
            setMessage(data.error || data.message || 'The verification link is invalid or has expired.');
          } catch {
            setMessage('The verification link is invalid or has expired.');
          }
          setStatus('error');
        }
      } catch (err) {
        if (cancelled) return;
        // Network-level failure
        console.error('[VerifyEmail] Fetch error:', err);
        setMessage('Could not reach the server. Please try again later.');
        setStatus('error');
      }
    };

    verify();

    // Cleanup: prevent state updates after unmount
    return () => { cancelled = true; };
  }, [token]);

  // ── Auto-redirect countdown on success ────────────────────────────────────
  useEffect(() => {
    if (status !== 'success') return;

    // Tick the countdown every second
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          navigate('/login');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [status, navigate]);

  // ── Resend verification email ──────────────────────────────────────────────
  const handleResend = useCallback(async () => {
    // Navigate back to a resend page, or you can implement an inline resend
    // flow here. Adjust the destination to match your route structure.
    navigate('/resend-verification');
  }, [navigate]);

  // ── Shared card styles ─────────────────────────────────────────────────────
  const cardStyle = {
    background: 'rgba(10,20,15,0.55)',
    border: '1px solid rgba(0,255,136,0.15)',
    borderRadius: 28,
    backdropFilter: 'blur(24px) saturate(160%)',
    WebkitBackdropFilter: 'blur(24px) saturate(160%)',
    boxShadow: '0 40px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(0,255,136,0.08)',
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="relative min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background: '#020402',
        fontFamily: "'Outfit', 'Inter', sans-serif",
        color: '#e0f2e9',
      }}
    >
      {/* Animated background blobs */}
      <BackgroundBlobs />

      {/* Dark vignette overlay */}
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, transparent 30%, rgba(2,4,3,0.72) 100%)',
          zIndex: 0,
        }}
      />

      {/* Card */}
      <main
        id="verify-email-card"
        className="relative w-full max-w-md text-center cropai-fade-in"
        style={{ ...cardStyle, padding: '3rem 2.5rem', zIndex: 10 }}
        role="main"
        aria-live="polite"
        aria-atomic="true"
      >
        {/* Logo */}
        <Logo />

        {/* ── Loading state ───────────────────────────────────────────────── */}
        {status === 'loading' && (
          <section
            key="loading"
            className="cropai-fade-in"
            aria-label="Verifying email"
          >
            <SpinnerIcon />
            <h1
              style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                letterSpacing: '-0.3px',
                color: '#e0f2e9',
                marginBottom: '0.5rem',
              }}
            >
              Verifying your email…
            </h1>
            <p style={{ color: '#8aa395', fontSize: '0.9375rem' }}>
              Please hold on while we confirm your link.
            </p>
          </section>
        )}

        {/* ── Success state ───────────────────────────────────────────────── */}
        {status === 'success' && (
          <section
            key="success"
            className="cropai-fade-in"
            aria-label="Email verified successfully"
          >
            <SuccessIcon />

            {/* Gradient heading */}
            <h1
              style={{
                fontSize: '1.6rem',
                fontWeight: 800,
                letterSpacing: '-0.5px',
                background: 'linear-gradient(135deg, #fff 0%, #00ff88 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                marginBottom: '0.75rem',
              }}
            >
              Email Verified! ✅
            </h1>

            <p style={{ color: '#8aa395', fontSize: '0.9375rem', marginBottom: '0.25rem' }}>
              {message || 'Your account has been successfully activated.'}
            </p>
            <p style={{ color: '#8aa395', fontSize: '0.9375rem', marginBottom: '2rem' }}>
              You can now sign in and start using&nbsp;
              <span style={{ color: '#00ff88', fontWeight: 600 }}>CropAI</span>.
            </p>

            {/* Go to Login button */}
            <button
              id="go-to-login-btn"
              onClick={() => navigate('/login')}
              style={{
                display: 'block',
                width: '100%',
                padding: '14px 0',
                borderRadius: 16,
                border: 'none',
                background: 'linear-gradient(135deg, #00ff88, #00a85d)',
                color: '#050a06',
                fontWeight: 800,
                fontSize: '1.05rem',
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                cursor: 'pointer',
                boxShadow: '0 10px 28px rgba(0,255,136,0.25)',
                transition: 'transform 0.3s cubic-bezier(0.175,0.885,0.32,1.275), box-shadow 0.3s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-3px) scale(1.02)';
                e.currentTarget.style.boxShadow = '0 16px 36px rgba(0,255,136,0.35)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0) scale(1)';
                e.currentTarget.style.boxShadow = '0 10px 28px rgba(0,255,136,0.25)';
              }}
              aria-label="Go to Login page"
            >
              Go to Login
            </button>

            {/* Auto-redirect countdown */}
            <CountdownRing seconds={countdown} />
          </section>
        )}

        {/* ── Error state ─────────────────────────────────────────────────── */}
        {status === 'error' && (
          <section
            key="error"
            className="cropai-fade-in"
            aria-label="Email verification failed"
          >
            <ErrorIcon />

            <h1
              style={{
                fontSize: '1.6rem',
                fontWeight: 800,
                letterSpacing: '-0.5px',
                background: 'linear-gradient(135deg, #fff 0%, #ff5050 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                marginBottom: '0.75rem',
              }}
            >
              Verification Failed ❌
            </h1>

            <p style={{ color: '#8aa395', fontSize: '0.9375rem', marginBottom: '2rem' }}>
              {message || 'The link is invalid or has expired. Please request a new one.'}
            </p>

            {/* Resend button */}
            <button
              id="resend-verification-btn"
              onClick={handleResend}
              style={{
                display: 'block',
                width: '100%',
                padding: '14px 0',
                borderRadius: 16,
                border: '1.5px solid rgba(255,80,80,0.45)',
                background: 'rgba(255,80,80,0.08)',
                color: '#ff8080',
                fontWeight: 700,
                fontSize: '1.05rem',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                marginBottom: '1rem',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,80,80,0.18)';
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 8px 20px rgba(255,80,80,0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,80,80,0.08)';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              aria-label="Resend verification email"
            >
              Resend Verification Email
            </button>

            {/* Back to login — secondary action */}
            <button
              id="back-to-login-btn"
              onClick={() => navigate('/login')}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#8aa395',
                fontSize: '0.875rem',
                cursor: 'pointer',
                textDecoration: 'underline',
                transition: 'color 0.2s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#00ff88'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#8aa395'; }}
              aria-label="Back to Login"
            >
              ← Back to Login
            </button>
          </section>
        )}

        {/* Divider + footer note */}
        <div
          style={{
            marginTop: '2.5rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid rgba(0,255,136,0.1)',
          }}
        >
          <p style={{ color: '#8aa395', fontSize: '0.8rem' }}>
            Having trouble?{' '}
            <a
              href="/support"
              style={{ color: '#00e5ff', textDecoration: 'none', fontWeight: 600 }}
            >
              Contact support
            </a>
          </p>
        </div>
      </main>
    </div>
  );
};

export default VerifyEmail;
