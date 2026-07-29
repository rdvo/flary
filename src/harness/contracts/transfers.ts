import { z } from "zod";

import { IdentifierSchema, TimestampSchema } from "./common";
import {
  ProjectFilePathSchema,
  Sha256HexSchema,
} from "./filesystem";

const TransferExpirySchema = z
  .number()
  .int()
  .min(30)
  .max(900)
  .default(300);

export const WorkspaceUploadTicketRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    size: z.number().int().positive().max(512 * 1024 * 1024),
    sha256: Sha256HexSchema,
    mediaType: z.string().trim().min(1).max(255),
    expiresInSeconds: TransferExpirySchema,
  })
  .strict();
export type WorkspaceUploadTicketRequest = z.output<
  typeof WorkspaceUploadTicketRequestSchema
>;
export type WorkspaceUploadTicketRequestInput = z.input<
  typeof WorkspaceUploadTicketRequestSchema
>;

export const WorkspaceDownloadTicketRequestSchema = z
  .object({
    path: ProjectFilePathSchema,
    expiresInSeconds: TransferExpirySchema,
  })
  .strict();
export type WorkspaceDownloadTicketRequest = z.output<
  typeof WorkspaceDownloadTicketRequestSchema
>;
export type WorkspaceDownloadTicketRequestInput = z.input<
  typeof WorkspaceDownloadTicketRequestSchema
>;

export const WorkspaceTransferTicketSchema = z
  .object({
    token: IdentifierSchema.min(32).max(256),
    operation: z.enum(["upload", "download"]),
    path: ProjectFilePathSchema,
    expiresAt: TimestampSchema,
    size: z.number().int().nonnegative().optional(),
    sha256: Sha256HexSchema.optional(),
    mediaType: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type WorkspaceTransferTicket = z.infer<
  typeof WorkspaceTransferTicketSchema
>;

export const WorkspaceTransferTicketResponseSchema =
  WorkspaceTransferTicketSchema.extend({
    uploadUrl: z.string().url().optional(),
    downloadUrl: z.string().url().optional(),
  }).strict();
export type WorkspaceTransferTicketResponse = z.infer<
  typeof WorkspaceTransferTicketResponseSchema
>;
