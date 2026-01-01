/**
 * KV (Key-Value) Message Handling
 *
 * Handles blob storage operations requested by the Cursor Agent:
 * - get_blob_args: Request to retrieve a stored blob
 * - set_blob_args: Request to store a blob
 *
 * Proto structure:
 * KvServerMessage:
 *   field 1: id (uint32) - message ID to include in response
 *   field 2: get_blob_args (GetBlobArgs)
 *   field 3: set_blob_args (SetBlobArgs)
 *
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 */

import { parseProtoFields } from "./decoding";
import { encodeUint32Field, encodeMessageField, concatBytes } from "./encoding";
import type { KvServerMessage } from "./types";

// Re-export type for convenience
export type { KvServerMessage };

/**
 * Parse KvServerMessage from protobuf bytes
 *
 * KvServerMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_args (GetBlobArgs) - contains blob_id
 *   field 3: set_blob_args (SetBlobArgs) - contains blob_id and blob_data
 */
export function parseKvServerMessage(data: Uint8Array): KvServerMessage {
  const fields = parseProtoFields(data);
  const result: KvServerMessage = { id: 0, messageType: 'unknown' };

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = field.value as number;
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // get_blob_args
      result.messageType = 'get_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // set_blob_args
      result.messageType = 'set_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        } else if (af.fieldNumber === 2 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobData = af.value;
        }
      }
    }
  }

  return result;
}

/**
 * Build KvClientMessage
 *
 * KvClientMessage:
 *   field 1: id (uint32)
 *   field 2: get_blob_result (GetBlobResult)
 *   field 3: set_blob_result (SetBlobResult)
 */
export function buildKvClientMessage(
  id: number,
  resultType: 'get_blob_result' | 'set_blob_result',
  result: Uint8Array
): Uint8Array {
  const fieldNumber = resultType === 'get_blob_result' ? 2 : 3;
  return concatBytes(
    encodeUint32Field(1, id),
    encodeMessageField(fieldNumber, result)
  );
}

/**
 * Build AgentClientMessage with kv_client_message
 *
 * AgentClientMessage:
 *   field 3: kv_client_message (KvClientMessage)
 */
export function buildAgentClientMessageWithKv(kvClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(3, kvClientMessage);
}
