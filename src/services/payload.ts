/**
 * Process a given payload for a collection to ensure the special fields (hash, uuid, date etc) are
 * handled correctly.
 */

import { System } from '../types/field';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import database from '../database';
import { clone, isObject } from 'lodash';
import { Relation, Item } from '../types';
import * as ItemsService from './items';
import { URL } from 'url';

type Operation = 'create' | 'read' | 'update';

type Transformers = {
	[type: string]: (operation: Operation, value: any, payload: Partial<Item>) => Promise<any>;
};

/**
 * @todo allow this to be extended
 *
 * @todo allow these extended special types to have "field dependencies"?
 * f.e. the file-links transformer needs the id and filename_download to be fetched from the DB
 * in order to work
 */
const transformers: Transformers = {
	async hash(operation, value) {
		if (!value) return;

		if (operation === 'create' || operation === 'update') {
			return await argon2.hash(String(value));
		}

		return value;
	},
	async uuid(operation, value) {
		if (operation === 'create' && !value) {
			return uuidv4();
		}

		return value;
	},
	async 'file-links'(operation, value, payload) {
		if (operation === 'read' && payload && payload.storage && payload.filename_disk) {
			const publicKey = `STORAGE_${payload.storage.toUpperCase()}_PUBLIC_URL`;

			return {
				asset_url: new URL(`/assets/${payload.id}`, process.env.PUBLIC_URL),
				public_url: new URL(payload.filename_disk, process.env[publicKey]),
			};
		}

		// This is an non-existing column, so there isn't any data to save
		return undefined;
	},
};

/**
 * Process and update all the special fields in the given payload
 *
 * @param collection Collection the payload goes in
 * @param operation If this is on create or on update
 * @param payload The actual payload itself
 * @returns The updated payload
 */

export async function processValues(
	operation: Operation,
	collection: string,
	payload: Partial<Item>
): Promise<Partial<Item>>;
export async function processValues(
	operation: Operation,
	collection: string,
	payload: Partial<Item>[]
): Promise<Partial<Item>[]>;
export async function processValues(
	operation: Operation,
	collection: string,
	payload: Partial<Item> | Partial<Item>[]
): Promise<Partial<Item> | Partial<Item>[]> {
	const processedPayload = Array.isArray(payload) ? clone(payload) : [clone(payload)];

	const specialFieldsInCollection = await database
		.select('field', 'special')
		.from<System>('directus_fields')
		.where({ collection: collection })
		.whereNotNull('special');

	await Promise.all(
		processedPayload.map(async (record: any) => {
			await Promise.all(
				specialFieldsInCollection.map(async (field) => {
					record[field.field] = await processField(field, record, operation);
				})
			);
		})
	);

	if (Array.isArray(payload)) {
		return processedPayload;
	}

	return processedPayload[0];
}

async function processField(
	field: Pick<System, 'field' | 'special'>,
	payload: Partial<Item>,
	operation: Operation
) {
	if (!field.special) return payload[field.field];

	if (transformers.hasOwnProperty(field.special)) {
		return await transformers[field.special](operation, payload[field.field], payload);
	}

	return payload[field.field];
}

/**
 * Recursively checks for nested relational items, and saves them bottom up, to ensure we have IDs etc ready
 */
export const processM2O = async (collection: string, payload: Partial<Item>) => {
	const payloadClone = clone(payload);

	const relations = await database
		.select<Relation[]>('*')
		.from('directus_relations')
		.where({ collection_many: collection });

	// Only process related records that are actually in the payload
	const relationsToProcess = relations.filter((relation) => {
		return (
			payloadClone.hasOwnProperty(relation.field_many) &&
			isObject(payloadClone[relation.field_many])
		);
	});

	// Save all nested m2o records
	await Promise.all(
		relationsToProcess.map(async (relation) => {
			const relatedRecord: Partial<Item> = payloadClone[relation.field_many];
			const hasPrimaryKey = relatedRecord.hasOwnProperty(relation.primary_one);

			let relatedPrimaryKey: string | number;

			if (hasPrimaryKey) {
				relatedPrimaryKey = relatedRecord[relation.primary_one];
				await ItemsService.updateItem(
					relation.collection_one,
					relatedPrimaryKey,
					relatedRecord
				);
			} else {
				relatedPrimaryKey = await ItemsService.createItem(
					relation.collection_one,
					relatedRecord
				);
			}

			// Overwrite the nested object with just the primary key, so the parent level can be saved correctly
			payloadClone[relation.field_many] = relatedPrimaryKey;
		})
	);

	return payloadClone;
};

export const processO2M = async (collection: string, payload: Partial<Item>) => {
	const payloadClone = clone(payload);

	const relations = await database
		.select<Relation[]>('*')
		.from('directus_relations')
		.where({ collection_one: collection });

	// Only process related records that are actually in the payload
	const relationsToProcess = relations.filter((relation) => {
		return (
			payloadClone.hasOwnProperty(relation.field_one) &&
			Array.isArray(payloadClone[relation.field_one])
		);
	});

	// Save all nested o2m records
	await Promise.all(
		relationsToProcess.map(async (relation) => {
			const relatedRecords = payloadClone[relation.field_one];

			await Promise.all(
				relatedRecords.map(async (relatedRecord: Partial<Item>, index: number) => {
					relatedRecord[relation.field_many] = payloadClone[relation.primary_one];

					const hasPrimaryKey = relatedRecord.hasOwnProperty(relation.primary_many);

					let relatedPrimaryKey: string | number;

					if (hasPrimaryKey) {
						relatedPrimaryKey = relatedRecord[relation.primary_many];

						await ItemsService.updateItem(
							relation.collection_many,
							relatedPrimaryKey,
							relatedRecord
						);
					} else {
						relatedPrimaryKey = await ItemsService.createItem(
							relation.collection_many,
							relatedRecord
						);
					}

					relatedRecord[relation.primary_many] = relatedPrimaryKey;

					payloadClone[relation.field_one][index] = relatedRecord;
				})
			);
		})
	);

	return payloadClone;
};
