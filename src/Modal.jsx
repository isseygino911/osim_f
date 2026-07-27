import { AnimatePresence, motion } from "framer-motion";

// Shared modal chrome: backdrop fade + panel scale/fade-in, used by the buy modal,
// the indicator help modal, and the news detail drawer. `open` gates mount via
// AnimatePresence so the exit transition plays before the panel unmounts.
export function Modal({ open, onClose, className = "", children }) {
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
            className={`modal ${className}`.trim()}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
