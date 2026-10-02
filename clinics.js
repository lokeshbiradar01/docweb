const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Clinic = require('../models/Clinic');
const Doctor = require('../models/Doctor');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/clinics
// @desc    Get all clinics with search and filter
// @access  Public
router.get('/', [
  query('search').optional().trim(),
  query('city').optional().trim(),
  query('specialty').optional().trim(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      search,
      city,
      specialty,
      page = 1,
      limit = 10
    } = req.query;

    // Build filter object
    const filter = { isActive: true };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { specialties: { $in: [new RegExp(search, 'i')] } }
      ];
    }

    if (city) {
      filter['address.city'] = { $regex: city, $options: 'i' };
    }

    if (specialty) {
      filter.specialties = { $in: [new RegExp(specialty, 'i')] };
    }

    const skip = (page - 1) * limit;

    const clinics = await Clinic.find(filter)
      .populate('admin', 'name email phone')
      .populate('doctors', 'specialty status user')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ 'rating.average': -1, createdAt: -1 });

    const total = await Clinic.countDocuments(filter);

    res.json({
      clinics,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalClinics: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get clinics error:', error);
    res.status(500).json({ message: 'Server error while fetching clinics' });
  }
});

// @route   GET /api/clinics/:id
// @desc    Get single clinic by ID
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const clinic = await Clinic.findById(req.params.id)
      .populate('admin', 'name email phone')
      .populate({
        path: 'doctors',
        populate: {
          path: 'user',
          select: 'name email phone'
        }
      });

    if (!clinic) {
      return res.status(404).json({ message: 'Clinic not found' });
    }

    res.json({ clinic });
  } catch (error) {
    console.error('Get clinic error:', error);
    res.status(500).json({ message: 'Server error while fetching clinic' });
  }
});

// @route   POST /api/clinics
// @desc    Create a new clinic
// @access  Private (Clinic Admin)
router.post('/', auth, authorize('clinic_admin'), [
  body('name').trim().notEmpty().withMessage('Clinic name is required'),
  body('address.city').trim().notEmpty().withMessage('City is required'),
  body('address.state').trim().notEmpty().withMessage('State is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('specialties').isArray().withMessage('Specialties must be an array')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const clinicData = {
      ...req.body,
      admin: req.user._id
    };

    const clinic = new Clinic(clinicData);
    await clinic.save();

    const populatedClinic = await Clinic.findById(clinic._id)
      .populate('admin', 'name email phone');

    res.status(201).json({
      message: 'Clinic created successfully',
      clinic: populatedClinic
    });
  } catch (error) {
    console.error('Create clinic error:', error);
    res.status(500).json({ message: 'Server error while creating clinic' });
  }
});

// @route   PUT /api/clinics/:id
// @desc    Update clinic
// @access  Private (Clinic Admin)
router.put('/:id', auth, authorize('clinic_admin'), [
  body('name').optional().trim().notEmpty().withMessage('Clinic name cannot be empty'),
  body('phone').optional().trim().notEmpty().withMessage('Phone number cannot be empty'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const clinic = await Clinic.findOne({
      _id: req.params.id,
      admin: req.user._id
    });

    if (!clinic) {
      return res.status(404).json({ message: 'Clinic not found or not authorized' });
    }

    const updatedClinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('admin', 'name email phone')
     .populate({
       path: 'doctors',
       populate: {
         path: 'user',
         select: 'name email phone'
       }
     });

    res.json({
      message: 'Clinic updated successfully',
      clinic: updatedClinic
    });
  } catch (error) {
    console.error('Update clinic error:', error);
    res.status(500).json({ message: 'Server error while updating clinic' });
  }
});

// @route   POST /api/clinics/:id/doctors
// @desc    Add doctor to clinic
// @access  Private (Clinic Admin)
router.post('/:id/doctors', auth, authorize('clinic_admin'), [
  body('doctorId').isMongoId().withMessage('Valid doctor ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { doctorId } = req.body;
    const clinicId = req.params.id;

    // Check if clinic exists and user is admin
    const clinic = await Clinic.findOne({
      _id: clinicId,
      admin: req.user._id
    });

    if (!clinic) {
      return res.status(404).json({ message: 'Clinic not found or not authorized' });
    }

    // Check if doctor exists
    const doctor = await Doctor.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ message: 'Doctor not found' });
    }

    // Check if doctor is already in clinic
    if (clinic.doctors.includes(doctorId)) {
      return res.status(400).json({ message: 'Doctor is already in this clinic' });
    }

    // Add doctor to clinic
    clinic.doctors.push(doctorId);
    await clinic.save();

    // Update doctor's current clinic
    doctor.currentClinic = clinicId;
    await doctor.save();

    const updatedClinic = await Clinic.findById(clinicId)
      .populate('admin', 'name email phone')
      .populate({
        path: 'doctors',
        populate: {
          path: 'user',
          select: 'name email phone'
        }
      });

    res.json({
      message: 'Doctor added to clinic successfully',
      clinic: updatedClinic
    });
  } catch (error) {
    console.error('Add doctor to clinic error:', error);
    res.status(500).json({ message: 'Server error while adding doctor to clinic' });
  }
});

// @route   DELETE /api/clinics/:id/doctors/:doctorId
// @desc    Remove doctor from clinic
// @access  Private (Clinic Admin)
router.delete('/:id/doctors/:doctorId', auth, authorize('clinic_admin'), async (req, res) => {
  try {
    const clinicId = req.params.id;
    const doctorId = req.params.doctorId;

    // Check if clinic exists and user is admin
    const clinic = await Clinic.findOne({
      _id: clinicId,
      admin: req.user._id
    });

    if (!clinic) {
      return res.status(404).json({ message: 'Clinic not found or not authorized' });
    }

    // Remove doctor from clinic
    clinic.doctors = clinic.doctors.filter(id => id.toString() !== doctorId);
    await clinic.save();

    // Update doctor's current clinic
    await Doctor.findByIdAndUpdate(doctorId, { currentClinic: null });

    const updatedClinic = await Clinic.findById(clinicId)
      .populate('admin', 'name email phone')
      .populate({
        path: 'doctors',
        populate: {
          path: 'user',
          select: 'name email phone'
        }
      });

    res.json({
      message: 'Doctor removed from clinic successfully',
      clinic: updatedClinic
    });
  } catch (error) {
    console.error('Remove doctor from clinic error:', error);
    res.status(500).json({ message: 'Server error while removing doctor from clinic' });
  }
});

module.exports = router;
