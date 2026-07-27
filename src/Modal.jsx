import { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";

const SWIPE_DISMISS_PX = 100;
const SWIPE_DISMISS_VELOCITY = 0.5; // px/ms, a fast flick dismisses even under the distance threshold

// Shared modal chrome: backdrop fade + panel transition, used by the buy modal, the
// indicator help modal, the news detail drawer, and the mobile-only chart-settings/
// account sheets. `open` gates mount via AnimatePresence so the exit transition plays
// before the panel unmounts.
//
// variant="centered" (default): desktop/tablet behavior, unchanged — a fixed-width box
// scaling in/out at the center of the screen.
// variant="sheet": mobile — a bottom-anchored panel that slides up from `y: "100%"`,
// with a drag-handle bar and swipe-down-to-dismiss.
export function Modal({ open, onClose, className = "", variant = "centered", children }) {
  const touchStartY = useRef(null);
  const touchStartAt = useRef(0);
  const dragY = useRef(0);
  const panelRef = useRef(null);
  const isSheet = variant === "sheet";

  function onTouchStart(e) {
    if (!isSheet || e.touches.length !== 1) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartAt.current = e.timeStamp;
    dragY.current = 0;
  }
  function onTouchMove(e) {
    if (!isSheet || touchStartY.current == null || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    dragY.current = dy;
    if (dy > 0 && panelRef.current) panelRef.current.style.transform = `translateY(${dy}px)`;
  }
  function onTouchEnd(e) {
    if (!isSheet || touchStartY.current == null) return;
    const dy = dragY.current;
    const dt = Math.max(1, e.timeStamp - touchStartAt.current);
    const velocity = dy / dt;
    touchStartY.current = null;
    if (panelRef.current) panelRef.current.style.transform = "";
    if (dy > SWIPE_DISMISS_PX || velocity > SWIPE_DISMISS_VELOCITY) onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-bg"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          <motion.div
            ref={panelRef}
            className={`modal ${isSheet ? "modal-sheet" : ""} ${className}`.trim()}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            initial={isSheet ? { y: "100%" } : { opacity: 0, scale: 0.96 }}
            animate={isSheet ? { y: 0 } : { opacity: 1, scale: 1 }}
            exit={isSheet ? { y: "100%" } : { opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {isSheet && <div className="sheet-handle" />}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
