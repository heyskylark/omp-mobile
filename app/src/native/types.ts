import type { PushEnvironment } from "@omp-mobile/protocol";

/** A paired computer as the JS layer sees it. Secrets never cross into JS except the bearer token needed for fetch/WebSocket. */
export interface PairedMachine {
	machineId: string;
	name: string;
	url: string;
	deviceId: string;
	token: string;
	pairedAt: string;
}

export interface MachineSecretInput extends PairedMachine {
	/** base64 AES-256-GCM push key; stored only in the shared keychain for the Notification Service Extension. */
	pushKey: string;
}

export interface NotificationOpen {
	machineId: string;
	sessionId: string;
	interactionId?: string;
}

export interface ActionResult {
	machineId: string;
	sessionId: string;
	interactionId: string;
	action: "APPROVE" | "DENY" | "REPLY";
	ok: boolean;
	message?: string;
}

/** An image pasted into a text field, saved by the native layer as a temporary JPEG. */
export interface PastedImage {
	uri: string;
	width: number;
	height: number;
}

export interface OmpNativeModule {
	listMachines(): Promise<PairedMachine[]>;
	saveMachine(machine: MachineSecretInput): Promise<void>;
	/** Changes the stored display name only; the token, push key, and socket are untouched. */
	renameMachine(machineId: string, name: string): Promise<void>;
	removeMachine(machineId: string): Promise<void>;
	/** Requests notification permission, installs categories, registers with APNs. Resolves null when denied or unavailable (simulator without push). */
	registerForPush(): Promise<{ token: string; environment: PushEnvironment } | null>;
	/** Notification tap that launched or foregrounded the app, consumed once. */
	consumeLaunchNotification(): Promise<NotificationOpen | null>;
	addNotificationOpenListener(listener: (open: NotificationOpen) => void): { remove(): void };
	addActionResultListener(listener: (result: ActionResult) => void): { remove(): void };
	/** Fires when the user chooses Paste in a text field while the clipboard holds only images. */
	addPasteImagesListener(listener: (event: { images: PastedImage[] }) => void): { remove(): void };
}
