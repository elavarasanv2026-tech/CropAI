/**
 * SuccessModal.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * CropAI — Success Modal Component
 *
 * Features:
 *  • Displays a centered modal for successful signup
 *  • Dark green gradient overlay with background blur
 *  • Glassmorphism card effect with neon green accents
 *  • Smooth enter animations (fade + scale up) using injected CSS keyframes
 *  • Fully responsive (mobile-first Tailwind classes)
 *  • Follows the "Futuristic Jungle" design system of CropAI
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   import SuccessModal from './SuccessModal';
 *
 *   function App() {
 *     const [showModal, setShowModal] = useState(false);
 *
 *     return (
 *       <>
 *         <button onClick={() => setShowModal(true)}>Sign Up</button>
 *         <SuccessModal
 *           isOpen={showModal}
 *           onClose={() => setShowModal(false)}
 *           onRedirect={() => navigate('/login')} // optional redirection
 *         />
 *       </>
 *     );
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect } from 'react';

// ─── Inline keyframe styles (injected once) ──────────────────────────────────
const MODAL_ANIMATION_STYLE = `
  @keyframes cropai-modal-backdrop-fade {
    from { opacity: 0; backdrop-filter: blur(0px); }
    to { opacity: 1; backdrop-filter: blur(12px); }
  }
  @keyframes cropai-modal-scale-in {
    from { opacity: 0; transform: scale(0.95) translateY(20px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes cropai-pulse-icon-bg {
    0% { transform: scale(1); opacity: 0.1; }
    50% { transform: scale(1.15); opacity: 0.2; }
    100% { transform: scale(1); opacity: 0.1; }
  }

  .cropai-backdrop-enter {
    animation: cropai-modal-backdrop-fade 0.4s ease-out forwards;
  }
  .cropai-modal-enter {
    animation: cropai-modal-scale-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .cropai-icon-bg-pulse {
    animation: cropai-pulse-icon-bg 3s ease-in-out infinite;
  }
`;

/**
 * Animated and styled Email SVG Icon
 */
const EmailIcon = () => (
  <div className="relative flex items-center justify-center w-20 h-20 mx-auto mb-6">
    {/* Pulsing background glow */}
    <div
      className="absolute inset-0 rounded-full cropai-icon-bg-pulse"
      style={{
        background: 'linear-gradient(135deg, rgba(0,255,136,0.8), rgba(0,168,93,0.8))',
        filter: 'blur(16px)',
      }}
    />
    
    {/* Inner ring */}
    <div
      className="relative z-10 flex items-center justify-center w-full h-full rounded-full"
      style={{
        background: 'rgba(10,20,15,0.8)',
        border: '1px solid rgba(0,255,136,0.3)',
        boxShadow: 'inset 0 0 20px rgba(0,255,136,0.1)',
      }}
    >
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="text-[#00ff88]"
      >
        <path
          d="M22 6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6M22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6M22 6L12 13L2 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  </div>
);

/**
 * SuccessModal Component
 *
 * @param {boolean} isOpen - Controls visibility
 * @param {function} onClose - function to call when closing the modal
 * @param {function} onRedirect - optional function to redirect user
 */
const SuccessModal = ({ isOpen, onClose, onRedirect }) => {
  // Inject animations safely outside React lifecycle (if not present)
  useEffect(() => {
    if (document.getElementById('cropai-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'cropai-modal-style';
    style.textContent = MODAL_ANIMATION_STYLE;
    document.head.appendChild(style);
  }, []);

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  const handleButtonClick = () => {
    onClose();
    if (onRedirect) {
      // Small timeout allows the user to see the button press before navigation
      setTimeout(() => {
        onRedirect();
      }, 150);
    }
  };

  if (!isOpen) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 cropai-backdrop-enter"
      style={{
        background: 'radial-gradient(circle at center, rgba(10,30,20,0.6) 0%, rgba(2,4,2,0.9) 100%)',
        // Note: backdrop-filter is handled in the CSS animation
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="success-modal-title"
    >
      {/* Modal Card */}
      <div
        className="relative w-full max-w-[420px] text-center cropai-modal-enter"
        style={{
          background: 'rgba(10,20,15,0.7)',
          backdropFilter: 'blur(16px) saturate(180%)',
          WebkitBackdropFilter: 'blur(16px) saturate(180%)', // Safari support
          border: '1px solid rgba(0,255,136,0.2)',
          borderRadius: '28px',
          padding: '2.5rem 2rem',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7), 0 0 40px rgba(0,255,136,0.08)',
          fontFamily: "'Outfit', 'Inter', sans-serif",
        }}
      >
        {/* Glow accent at the top */}
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-[2px]"
          style={{
            background: 'linear-gradient(90deg, transparent, #00ff88, transparent)',
            opacity: 0.8,
            filter: 'blur(1px)',
            borderRadius: '100%',
          }}
        />

        <EmailIcon />

        {/* Title */}
        <h2
          id="success-modal-title"
          className="mb-4 text-2xl md:text-3xl font-bold tracking-tight"
          style={{
            background: 'linear-gradient(135deg, #ffffff 0%, #00ff88 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          Account Created
        </h2>

        {/* Subtitle */}
        <p
          className="mb-8 leading-relaxed"
          style={{
            color: '#8aa395',
            fontSize: '0.95rem',
          }}
        >
          Your account was successfully created. <br className="hidden sm:block" />
          Please check your inbox to verify your email.
        </p>

        {/* Action Button */}
        <button
          onClick={handleButtonClick}
          className="w-full font-bold uppercase tracking-wide transition-all duration-300 outline-none focus:ring-4 focus:ring-[#00ff88]/30 group"
          style={{
            padding: '16px 0',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, #00ff88, #00a85d)',
            color: '#050a06',
            fontSize: '1rem',
            border: 'none',
            boxShadow: '0 8px 24px rgba(0,255,136,0.25)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px) scale(1.02)';
            e.currentTarget.style.boxShadow = '0 12px 32px rgba(0,255,136,0.35)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0) scale(1)';
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,255,136,0.25)';
          }}
          aria-label="Acknowledge success and close modal"
        >
          <span className="relative z-10 flex items-center justify-center gap-2">
            Got it
            {/* Tiny arrow animation on hover using utility classes */}
            <svg
              className="w-4 h-4 transition-transform duration-300 transform group-hover:translate-x-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </span>
        </button>
      </div>
    </div>
  );
};

export default SuccessModal;
