// Renders the RemoteFolderPicker inside a dialog when modal state is
// 'remote-folder-picker'. The picker's onPick stashes the chosen path back
// onto modalData and re-invokes the originating flow (`addRepo` for now).
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

  const handlePick = useCallback(
    (path: string) => {
      useAppStore.setState((s) => ({ modalData: { ...s.modalData, remotePickedPath: path } }))
      closeModal()
      // Why: re-enter the originating flow so the caller picks the queued
      // path off modalData and proceeds. For now the only flow is add-repo;
      // future flows would dispatch by `mode`.
      if (mode === 'add-repo') {
        void addRepo()
      }
    },
    [addRepo, closeModal, mode]
  )

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeModal()
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">Pick a folder</DialogTitle>
        </DialogHeader>
        <RemoteFolderPicker
          initialValue="~"
          placeholder="~/path/to/repo"
          onPick={handlePick}
          onCancel={closeModal}
        />
      </DialogContent>
    </Dialog>
  )
})

export default RemoteFolderPickerDialog
