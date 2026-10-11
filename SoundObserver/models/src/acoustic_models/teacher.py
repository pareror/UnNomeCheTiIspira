"""Offline teacher hook for pseudo-labelling and knowledge distillation.

Large AudioSet backbones (YAMNet / PANNs) cannot run on a sub-7-EUR MCU, so
they are used *off-device* to label data or to distil soft targets into the
tiny DS-CNN. This module maps a teacher's class scores onto the student's
class space via a fixed, user-provided mapping matrix.
"""

from __future__ import annotations

from typing import Mapping

import torch


class TeacherSoftLabels:
    """Map ``(B, n_teacher)`` teacher probabilities to ``(B, n_student)`` soft targets."""

    def __init__(self, mapping: torch.Tensor, normalize: bool = True) -> None:
        mapping = torch.as_tensor(mapping, dtype=torch.float32)
        if mapping.dim() != 2:
            raise ValueError("mapping must be 2-D (n_teacher, n_student)")
        if normalize:
            col = mapping.sum(dim=0, keepdim=True).clamp(min=1e-8)
            mapping = mapping / col
        self.mapping = mapping  # (n_teacher, n_student)

    @classmethod
    def from_dict(
        cls,
        groups: Mapping[str, list[int]],
        n_teacher: int,
        class_names: list[str],
    ) -> "TeacherSoftLabels":
        """Build a mapping from ``{student_class: [teacher_indices]}``."""
        n_student = len(class_names)
        mapping = torch.zeros(n_teacher, n_student)
        for col, name in enumerate(class_names):
            for idx in groups.get(name, []):
                mapping[idx, col] = 1.0
        return cls(mapping)

    def __call__(self, teacher_scores: torch.Tensor) -> torch.Tensor:
        # (B, n_teacher) @ (n_teacher, n_student) -> (B, n_student)
        return teacher_scores @ self.mapping
