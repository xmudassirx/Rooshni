"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { archiveContactAction, type ArchiveContactState } from "../actions";

const initialState: ArchiveContactState = { error: null };

/*
 * Session 30 (177c): the ARCHIVE control — rendered only for the owner (the
 * pure canArchiveContact truth; decision 116: no control that cannot act).
 * The confirm dialog names exactly what archiving does. Reason optional,
 * evented either way. There is no delete and no undo control here —
 * deletion does not exist (append-only).
 */
export function ArchiveContactControl({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const [state, submit, submitting] = useActionState(archiveContactAction, initialState);
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Archived contacts leave the book — back to the list, which no longer
  // holds the row.
  useEffect(() => {
    if (state.archived) router.push("/contacts");
  }, [state.archived, router]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="ghost" disabled={submitting}>
            <Archive /> Archive
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {contactName}?</DialogTitle>
            <DialogDescription>
              Archiving removes this contact from lead resolution — a new
              enquiry with their email or phone number opens as a fresh lead —
              and withdraws every channel from consent, so nothing further can
              be sent to them. Their history (conversations, enquiries, The
              Record) stands untouched. Deletion does not exist: the archive is
              recorded on The Record, with your reason if you give one.
            </DialogDescription>
          </DialogHeader>
          <form action={submit} className="flex flex-col gap-3">
            <input type="hidden" name="contact_id" value={contactId} />
            <input
              name="reason"
              placeholder="Reason (optional) — recorded on The Record"
              className="rounded-md border border-rule bg-paper px-2.5 py-2 text-[13px]"
            />
            {state.error ? <p className="text-[12.5px] text-stamp">{state.error}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button size="sm" type="submit" disabled={submitting}>
                {submitting ? "Archiving…" : "Archive contact"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
