import { create } from "zustand";
import type { ServerInfo } from "@omp-mobile/protocol";
import { OmpNative } from "../../modules/omp-native";
import { resetMachineSocket } from "./live";
import type { MachineSecretInput, PairedMachine } from "../native/types";

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface MachinesState {
	machines: PairedMachine[];
	loadState: LoadState;
	load(): Promise<void>;
	save(machine: MachineSecretInput): Promise<void>;
	applyInfo(machineId: string, info: ServerInfo): Promise<void>;
	remove(machineId: string): Promise<void>;
}

export const useMachines = create<MachinesState>((set, get) => ({
	machines: [],
	loadState: { kind: "loading" },
	async load() {
		set({ loadState: { kind: "loading" } });
		try {
			const machines = await OmpNative.listMachines();
			set({ machines, loadState: { kind: "ready" } });
		} catch (error) {
			set({
				loadState: { kind: "error", message: error instanceof Error ? error.message : "Could not load computers." },
			});
		}
	},
	async save(machine) {
		await OmpNative.saveMachine(machine);
		resetMachineSocket(machine.machineId);
		const publicMachine: PairedMachine = machine;
		set({ machines: [...get().machines.filter((item) => item.machineId !== machine.machineId), publicMachine] });
	},
	async applyInfo(machineId, info) {
		const stored = get().machines.find((machine) => machine.machineId === machineId);
		if (!stored || info.machineId !== machineId || info.machineName === stored.name) return;
		await OmpNative.renameMachine(machineId, info.machineName);
		set({
			machines: get().machines.map((machine) =>
				machine.machineId === machineId ? { ...machine, name: info.machineName } : machine,
			),
		});
	},
	async remove(machineId) {
		await OmpNative.removeMachine(machineId);
		set({ machines: get().machines.filter((machine) => machine.machineId !== machineId) });
	},
}));

export function useMachine(machineId: string | undefined): PairedMachine | undefined {
	return useMachines((state) => state.machines.find((machine) => machine.machineId === machineId));
}
