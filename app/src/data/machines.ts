import { create } from "zustand";
import { OmpNative } from "../../modules/omp-native";
import type { MachineSecretInput, PairedMachine } from "../native/types";

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface MachinesState {
	machines: PairedMachine[];
	loadState: LoadState;
	load(): Promise<void>;
	save(machine: MachineSecretInput): Promise<void>;
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
		const publicMachine: PairedMachine = machine;
		set({ machines: [...get().machines.filter((item) => item.machineId !== machine.machineId), publicMachine] });
	},
	async remove(machineId) {
		await OmpNative.removeMachine(machineId);
		set({ machines: get().machines.filter((machine) => machine.machineId !== machineId) });
	},
}));

export function useMachine(machineId: string | undefined): PairedMachine | undefined {
	return useMachines((state) => state.machines.find((machine) => machine.machineId === machineId));
}
