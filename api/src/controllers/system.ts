import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import DatabaseBackupService from '../services/dbbackup';
import { DatabaseNotFoundException, InvalidCredentialsException } from '../exceptions';
import env from '../env';

const router = Router();

router.get(
	'/backup',
	asyncHandler(async (req, res, next) => {
		if (!req.accountability?.user || !req.accountability?.role) {
			throw new InvalidCredentialsException();
		}

		const backupPath = env.DB_BACKUP_PATH;
		const backupName = env.DB_BACKUP_NAME;
		const dbService = new DatabaseBackupService({ accountability: req.accountability });
		const path = require('path');
		const fs = require('fs');

		const backup = path.normalize(path.resolve(`${backupPath}/${backupName}.gz`));
		const stat = fs.statSync(backup);
		await dbService.exportDb();
		res.attachment(backupName);

		res.set('Content-Type', 'application/octet-stream');
		res.set('content-length', stat.size);
		const stream = fs.createReadStream(backup, 'utf8');

		stream.on('open', () => {
			stream.pipe(res);
		});

		stream.on('error', (error: Error) => {
			throw new DatabaseNotFoundException(error.message);
		});

		await dbService.cleanUp(backup);
	})
);

export default router;
