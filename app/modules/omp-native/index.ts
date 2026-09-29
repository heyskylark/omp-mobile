import { NativeModule, requireNativeModule } from "expo";
import type {
	ActionResult,
	MachineSecretInput,
	NotificationOpen,
	OmpNativeModule as OmpNativeContract,
	PairedMachine,
} from "../../src/native/types";
import type { PushEnvironment } from "@omp-mobile/protocol";

type OmpNativeEvents = {
	onNotificationOpen(open: NotificationOpen): void;
	onActionResult(result: ActionResult): void;
};

declare class NativeOmpModule extends NativeModule<OmpNativeEvents> {
	listMachines(): Promise<PairedMachine[]>;
	saveMachine(machine: MachineSecretInput): Promise<void>;
	removeMachine(machineId: string): Promise<void>;
	registerForPush(): Promise<{ token: string; environment: PushEnvironment } | null>;
	consumeLaunchNotification(): Promise<NotificationOpen | null>;
}

const nativeModule = requireNativeModule<NativeOmpModule>("OmpNative");

export const OmpNative: OmpNativeContract = {
	listMachines: () => nativeModule.listMachines(),
	saveMachine: (machine) => nativeModule.saveMachine(machine),
	removeMachine: (machineId) => nativeModule.removeMachine(machineId),
	registerForPush: () => nativeModule.registerForPush(),
	consumeLaunchNotification: () => nativeModule.consumeLaunchNotification(),
	addNotificationOpenListener: (listener) => nativeModule.addListener("onNotificationOpen", listener),
	addActionResultListener: (listener) => nativeModule.addListener("onActionResult", listener),
};

export default OmpNative;
