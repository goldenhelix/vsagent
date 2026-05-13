// Renders the RemoteFolderPicker inside a dialog when modal state is
// 'remote-folder-picker'. The picker's onPick stashes the chosen path back
// onto modalData and re-invokes the originating flow (`addRepo` by default,
// or an arbitrary `modalData.onPick` callback for flows like onboarding
// and the workspaceDir Browse button in Settings).
import React, { useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker'

const RemoteFolderPickerDialog = React.memo(function RemoteFolderPickerDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addRepo = useAppStore((s) => s.addRepo)

  const isOpen = activeModal === 'remote-folder-picker'
  const mode = typeof modalData.mode === 'string' ? modalData.mode : 'add-repo'
  // Why: callers that need custom completion (onboarding, settings, etc.)
  // pass a function via modalData.onPick. zustand state holds the function
  // in-memory (no serialization round-trip), so this is safe.
  const onPick = typeof modalData.onPick === 'function'
    ? (modalData.onPick as (path: string) => void)
    : null
  const title = typeof modalData.title === 'string' ? modalData.title : 'Pick a folder'
  const initialValue = typeof modalData.initialValue === 'string' ? modalData.initialValue : '~'
  const placeholder = typeof modalData.placeholder === 'string'
    ? modalData.placeholder
    : '~/path/to/repo'

  const handlePick = useCallback(
    (path: string) => {
      closeModal()
      if (onPick) {
        onPick(path)
        return
      }
      // Why: legacy default path — preserves the original add-repo flow when
      // callers don't supply onPick.
      if (mode === 'add-repo') {
        void addRepo(path)
      }
    },
    [addRepo, closeModal, mode, onPick]
  )

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeModal()
      }}
    >
      <DialogContent
        className="max-w-lg z-[200]"
        overlayClassName="z-[200]"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <RemoteFolderPicker
          initialValue={initialValue}
          placeholder={placeholder}
          onPick={handlePick}
          onCancel={closeModal}
        />
      </DialogContent>
    </Dialog>
  )
})

export default RemoteFolderPickerDialog
